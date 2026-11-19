import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CLEAN_ENV, directHttpsRequest, redactSecrets } from './bailian.mjs';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BILIBILI_REFERER = 'https://www.bilibili.com/';
const MAX_BAILIAN_BYTES = 1024 ** 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

const BARE_BV_RE = /^BV([0-9A-Za-z]{10})$/i;
const BARE_AV_RE = /^av([1-9]\d*)$/i;
const VIDEO_PATH_RE = /^\/(?:s\/)?video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)(?:\/|$)/i;
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const SHORT_HOSTS = new Set(['b23.tv', 'www.b23.tv']);

function createBiliError(message, exitCode, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.exitCode = exitCode;
  return err;
}

function parsePositivePage(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw createBiliError(`${label} 必须是 >= 1 的正整数: ${value}`, 2);
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw createBiliError(`${label} 必须是 >= 1 的正整数: ${value}`, 2);
    }
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 1) {
      throw createBiliError(`${label} 超出安全整数范围: ${value}`, 2);
    }
    return num;
  }
  throw createBiliError(`${label} 必须是 >= 1 的正整数`, 2);
}

function normalizeUrlCandidate(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^(?:(?:www\.|m\.)?bilibili\.com|(?:www\.)?b23\.tv)\//i.test(raw)) {
    return `https://${raw}`;
  }
  return null;
}

function parseVideoIdToken(token, page) {
  const bvMatch = BARE_BV_RE.exec(token);
  if (bvMatch) {
    return {
      kind: 'video',
      bvid: `BV${bvMatch[1]}`,
      aid: null,
      page,
    };
  }
  const avMatch = BARE_AV_RE.exec(token);
  if (avMatch) {
    const aid = Number(avMatch[1]);
    if (!Number.isSafeInteger(aid) || aid < 1) {
      throw createBiliError(`无效的 av 号: ${token}`, 2);
    }
    return {
      kind: 'video',
      bvid: null,
      aid,
      page,
    };
  }
  return null;
}

/**
 * Parse a Bilibili video identifier, standard URL, or b23.tv short URL.
 * @param {string} rawInput
 * @param {number|string|null} [explicitPage=null]
 * @returns {{ kind: 'video', bvid: string|null, aid: number|null, page: number } | { kind: 'short', shortUrl: string, explicitPage: number|null }}
 */
export function parseBiliInput(rawInput, explicitPage = null) {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    throw createBiliError('请输入有效的 B 站视频链接、BV 号或 av 号', 2);
  }

  const validatedExplicitPage =
    explicitPage !== null && explicitPage !== undefined
      ? parsePositivePage(explicitPage, '分 P 参数 (-p)')
      : null;

  const trimmed = rawInput.trim();
  const bareResult = parseVideoIdToken(trimmed, validatedExplicitPage ?? 1);
  if (bareResult) return bareResult;

  const urlCandidate = normalizeUrlCandidate(trimmed);
  if (!urlCandidate) {
    throw createBiliError(`无法识别的 B 站视频输入: ${trimmed}`, 2);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlCandidate);
  } catch (err) {
    throw createBiliError(`无效的 URL: ${trimmed}`, 2, err);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw createBiliError(`不支持的 URL 协议: ${parsedUrl.protocol}`, 2);
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (SHORT_HOSTS.has(hostname)) {
    const cleanPath = parsedUrl.pathname.replace(/\/+$/, '');
    if (!cleanPath || cleanPath === '/') {
      throw createBiliError(`无效的 b23.tv 短链（缺少短码）: ${trimmed}`, 2);
    }
    let shortPage = validatedExplicitPage;
    if (shortPage === null && parsedUrl.searchParams.has('p')) {
      shortPage = parsePositivePage(parsedUrl.searchParams.get('p'), 'URL 分 P 参数 (?p=)');
    }
    const cleanShortUrl = `https://${hostname}${parsedUrl.pathname}`;
    return {
      kind: 'short',
      shortUrl: cleanShortUrl,
      explicitPage: shortPage,
    };
  }

  if (!BILIBILI_HOSTS.has(hostname)) {
    throw createBiliError(`非 B 站视频链接: ${trimmed}`, 2);
  }

  const pathMatch = VIDEO_PATH_RE.exec(parsedUrl.pathname);
  if (!pathMatch) {
    throw createBiliError(`仅支持 B 站 /video/BV... 或 /video/av... 链接: ${trimmed}`, 2);
  }

  let page = validatedExplicitPage;
  if (page === null) {
    if (parsedUrl.searchParams.has('p')) {
      page = parsePositivePage(parsedUrl.searchParams.get('p'), 'URL 分 P 参数 (?p=)');
    } else {
      page = 1;
    }
  }

  const videoResult = parseVideoIdToken(pathMatch[1], page);
  if (!videoResult) {
    throw createBiliError(`无效的 B 站视频 ID: ${pathMatch[1]}`, 2);
  }
  return videoResult;
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.exitCode === 4) return true;
  if (err.code === 'ETIMEDOUT' || err.name === 'AbortError') return true;
  return /timed?\s*out|超时/i.test(String(err.message || ''));
}

function wrapNetworkError(err, context) {
  if (err?.exitCode === 2 || err?.exitCode === 4) return err;
  const code = isTimeoutError(err) ? 4 : 3;
  const msg = redactSecrets(err?.message || String(err));
  return createBiliError(`${context}: ${msg}`, code, err);
}

function extractVideoUrlFromHtml(html) {
  if (!html) return null;
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av[1-9]\d*)(?:[/?][^"'\s<>]*)?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1] || m[0];
  }
  return null;
}

async function resolveShortUrl(shortParsed, deadline) {
  let currentUrl = shortParsed.shortUrl;
  const explicitPage = shortParsed.explicitPage;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw createBiliError('解析 b23.tv 短链超时', 4);
    }

    let res;
    try {
      res = await directHttpsRequest(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Referer: BILIBILI_REFERER,
        },
        timeoutMs: remainingMs,
      });
    } catch (err) {
      throw wrapNetworkError(err, '解析 b23.tv 短链请求失败');
    }

    if (REDIRECT_STATUS_CODES.has(res.statusCode) && res.headers?.location) {
      const rawLoc = Array.isArray(res.headers.location)
        ? res.headers.location[0]
        : res.headers.location;
      let nextUrl;
      try {
        nextUrl = new URL(rawLoc, currentUrl).toString();
      } catch (err) {
        throw createBiliError(`b23.tv 返回无效重定向地址: ${rawLoc}`, 3, err);
      }
      try {
        const candidate = parseBiliInput(nextUrl, explicitPage);
        if (candidate.kind === 'video') {
          return candidate;
        }
        currentUrl = candidate.shortUrl;
      } catch {
        currentUrl = nextUrl;
      }
      continue;
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const htmlUrl = extractVideoUrlFromHtml(res.text());
      if (htmlUrl) {
        const candidate = parseBiliInput(htmlUrl, explicitPage);
        if (candidate.kind === 'video') return candidate;
      }
    }

    throw createBiliError(`b23.tv 短链解析失败 (HTTP ${res.statusCode}): ${currentUrl}`, 3);
  }

  throw createBiliError(`b23.tv 短链重定向超过 ${MAX_REDIRECT_HOPS} 跳`, 3);
}

/**
 * Resolve Bilibili input (BV, av, URL, or b23.tv) to canonical video & page metadata.
 * @param {string} rawInput
 * @param {{ page?: number|string|null, timeoutMs?: number }} [options]
 */
export async function resolveVideoTarget(rawInput, { page = null, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = parseBiliInput(rawInput, page);

  if (target.kind === 'short') {
    target = await resolveShortUrl(target, deadline);
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createBiliError('获取 B 站视频元数据超时', 4);
  }

  const query = target.bvid
    ? `bvid=${encodeURIComponent(target.bvid)}`
    : `aid=${encodeURIComponent(String(target.aid))}`;
  const viewUrl = `https://api.bilibili.com/x/web-interface/view?${query}`;

  let res;
  try {
    res = await directHttpsRequest(viewUrl, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Referer: BILIBILI_REFERER,
        Accept: 'application/json, text/plain, */*',
      },
      timeoutMs: remainingMs,
    });
  } catch (err) {
    throw wrapNetworkError(err, '请求 B 站 view API 失败');
  }

  if (res.statusCode !== 200) {
    throw createBiliError(`B 站 view API 返回 HTTP ${res.statusCode}`, 3);
  }

  let payload;
  try {
    payload = res.json();
  } catch (err) {
    throw createBiliError('解析 B 站 view API JSON 响应失败', 3, err);
  }

  if (!payload || payload.code !== 0 || !payload.data) {
    const apiMsg = payload?.message ? ` (${payload.message})` : '';
    throw createBiliError(`B 站 view API 错误 code=${payload?.code ?? 'unknown'}${apiMsg}`, 3);
  }

  const data = payload.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  if (pages.length === 0 || target.page < 1 || target.page > pages.length) {
    throw createBiliError(
      `分 P 序号无效: 请求 p=${target.page}，该视频共有 ${pages.length} 个分 P`,
      2,
    );
  }

  const pageObj = pages[target.page - 1];
  const bvid = data.bvid || target.bvid;
  const aid = data.aid ?? target.aid;
  const cid = pageObj?.cid ?? data.cid;

  if (!bvid || !cid) {
    throw createBiliError('B 站 view API 返回数据缺少 bvid 或 cid', 3);
  }

  const pageDur = Number(pageObj?.duration);
  const videoDur = Number(data.duration);
  const durationSec = Number.isFinite(pageDur) && pageDur > 0
    ? pageDur
    : (Number.isFinite(videoDur) && videoDur > 0 ? videoDur : 0);

  return {
    bvid,
    aid,
    cid,
    page: target.page,
    totalPages: pages.length,
    title: typeof data.title === 'string' ? data.title.trim() : '',
    partTitle: typeof pageObj?.part === 'string' ? pageObj.part.trim() : '',
    ownerName: typeof data.owner?.name === 'string' ? data.owner.name.trim() : '',
    durationSec,
    desc: typeof data.desc === 'string' ? data.desc.trim() : '',
    canonicalUrl: `https://www.bilibili.com/video/${bvid}?p=${target.page}`,
  };
}

function testSpawnVersion(bin, prefixArgs) {
  const res = spawnSync(bin, [...prefixArgs, '--version'], {
    env: CLEAN_ENV(process.env),
    encoding: 'utf8',
    timeout: 8_000,
    windowsHide: true,
  });
  return !res.error && res.status === 0;
}

/**
 * Resolve available yt-dlp invocation command on host.
 * @returns {{ bin: string, prefixArgs: string[] }}
 */
export function resolveYtDlpCommand() {
  const envBin = process.env.BILI_YTDLP_BIN?.trim();
  if (envBin) {
    if (testSpawnVersion(envBin, [])) {
      return { bin: envBin, prefixArgs: [] };
    }
    throw createBiliError(`BILI_YTDLP_BIN 指定的命令不可用: ${envBin}`, 3);
  }

  if (process.platform === 'win32') {
    const whereRes = spawnSync('where.exe', ['yt-dlp'], {
      env: CLEAN_ENV(process.env),
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (!whereRes.error && whereRes.status === 0 && whereRes.stdout.trim()) {
      const firstHit = whereRes.stdout.trim().split(/\r?\n/)[0].trim();
      if (firstHit && testSpawnVersion(firstHit, [])) {
        return { bin: firstHit, prefixArgs: [] };
      }
    }
  } else if (testSpawnVersion('yt-dlp', [])) {
    return { bin: 'yt-dlp', prefixArgs: [] };
  }

  if (testSpawnVersion('python', ['-m', 'yt_dlp'])) {
    return { bin: 'python', prefixArgs: ['-m', 'yt_dlp'] };
  }

  const fallbackCandidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'Python',
            'Python311',
            'Scripts',
            'yt-dlp.exe',
          ),
        ]
      : [];

  for (const candidate of new Set(fallbackCandidates)) {
    if (fs.existsSync(candidate) && testSpawnVersion(candidate, [])) {
      return { bin: candidate, prefixArgs: [] };
    }
  }

  throw createBiliError(
    '未找到可用的 yt-dlp（已检查 BILI_YTDLP_BIN、PATH、python -m yt_dlp 及 Python311 Scripts），请先安装 yt-dlp',
    3,
  );
}

function appendRollingOutput(prev, chunk, limit = 24_576) {
  const combined = prev + chunk.toString('utf8');
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function killChildTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        env: CLEAN_ENV(process.env),
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore cleanup failure
    }
  }
}

function runYtDlpProcess(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: CLEAN_ENV(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killChildTree(child);
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout = appendRollingOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendRollingOutput(stderr, chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(createBiliError(`启动 yt-dlp 进程失败: ${redactSecrets(err.message)}`, 3, err));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(createBiliError(`yt-dlp 拉流超时（超过 ${Math.ceil(timeoutMs / 1000)}s）`, 4));
        return;
      }
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

function clearDirectoryFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      fs.unlinkSync(full);
    } catch {
      // ignore best-effort cleanup before retry
    }
  }
}

function locateDownloadedMedia(outDir, expectedPath) {
  if (fs.existsSync(expectedPath)) {
    const stat = fs.statSync(expectedPath);
    if (stat.isFile() && stat.size > 0) {
      return { filePath: expectedPath, sizeBytes: stat.size };
    }
  }
  const entries = fs.readdirSync(outDir, { withFileTypes: true });
  const candidates = entries
    .filter((d) => d.isFile() && !/\.(part|ytdl|tmp|temp)$/i.test(d.name))
    .map((d) => {
      const p = path.join(outDir, d.name);
      return { filePath: p, sizeBytes: fs.statSync(p).size, isMp4: /\.mp4$/i.test(d.name) };
    })
    .filter((item) => item.sizeBytes > 0)
    .sort((a, b) => Number(b.isMp4) - Number(a.isMp4) || b.sizeBytes - a.sizeBytes);

  return candidates[0] ? { filePath: candidates[0].filePath, sizeBytes: candidates[0].sizeBytes } : null;
}

function formatYtDlpFailure(code, output) {
  const safeTail = redactSecrets(output.trim().split(/\r?\n/).slice(-8).join(' | '));
  if (/HTTP Error 412|\b412\b|-352|-403|风控|访问权限不足/i.test(output)) {
    return createBiliError(
      `B 站拒绝或触发风控拦截，请尝试传入 --cookies edge（或指定浏览器 / cookies.txt 文件）重试。详情: ${safeTail}`,
      3,
    );
  }
  return createBiliError(`yt-dlp 下载失败 (exit=${code}): ${safeTail || '无错误输出'}`, 3);
}

/**
 * Download full video or clipped segment via yt-dlp without proxy leakage.
 * @param {{ bvid?: string, page?: number, canonicalUrl: string }} meta
 * @param {{ quality?: number, clipRange?: { startSec: number, endSec: number }|null, cookies?: string, outDir: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ filePath: string, sizeBytes: number, downloadMs: number }>}
 */
export async function downloadBiliMedia(
  meta,
  { quality = 720, clipRange = null, cookies = '', outDir, timeoutMs = 300_000 } = {},
) {
  if (!meta || (!meta.canonicalUrl && !meta.bvid)) {
    throw createBiliError('缺少有效的视频元数据', 2);
  }
  if (!outDir || typeof outDir !== 'string') {
    throw createBiliError('缺少输出目录 outDir', 2);
  }
  const qualityNum = Number(quality);
  if (!Number.isFinite(qualityNum) || qualityNum <= 0) {
    throw createBiliError(`无效的视频画质参数: ${quality}`, 2);
  }
  if (clipRange !== null && clipRange !== undefined) {
    const start = Number(clipRange.startSec);
    const end = Number(clipRange.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw createBiliError(`无效的切片时间区间: ${JSON.stringify(clipRange)}`, 2);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  const targetUrl =
    meta.canonicalUrl || `https://www.bilibili.com/video/${meta.bvid}?p=${meta.page || 1}`;
  const { bin, prefixArgs } = resolveYtDlpCommand();

  const clipSuffix = clipRange ? `_c${clipRange.startSec}_${clipRange.endSec}` : '';
  const baseName = `${meta.bvid || 'bili'}_p${meta.page || 1}_q${qualityNum}${clipSuffix}`;
  const outTemplate = path.join(outDir, `${baseName}.%(ext)s`);
  const expectedPath = path.join(outDir, `${baseName}.mp4`);

  const formatSelector =
    `bestvideo[height<=${qualityNum}][vcodec^=avc]+bestaudio[acodec^=mp4a]/` +
    `bestvideo[height<=${qualityNum}]+bestaudio/best[height<=${qualityNum}]`;

  const baseArgs = [
    ...prefixArgs,
    '--proxy', '',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--merge-output-format', 'mp4',
    '-f', formatSelector,
    '-o', outTemplate,
  ];

  if (clipRange) {
    baseArgs.push(
      '--download-sections', `*${clipRange.startSec}-${clipRange.endSec}`,
      '--force-keyframes-at-cuts',
    );
  }

  if (cookies && String(cookies).trim()) {
    const cookieVal = String(cookies).trim();
    if (fs.existsSync(cookieVal) && fs.statSync(cookieVal).isFile()) {
      baseArgs.push('--cookies', cookieVal);
    } else {
      baseArgs.push('--cookies-from-browser', cookieVal);
    }
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let result = await runYtDlpProcess(bin, [...baseArgs, targetUrl], timeoutMs);
  let combinedOutput = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0 && /HTTP Error 412|\b412\b/i.test(combinedOutput)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw createBiliError(`yt-dlp 重试 412 前已超时（>${Math.ceil(timeoutMs / 1000)}s）`, 4);
    }
    clearDirectoryFiles(outDir);
    result = await runYtDlpProcess(
      bin,
      [...baseArgs, '--user-agent', BROWSER_USER_AGENT, '--referer', BILIBILI_REFERER, targetUrl],
      remainingMs,
    );
    combinedOutput = `${result.stdout}\n${result.stderr}`;
  }

  if (result.code !== 0) {
    throw formatYtDlpFailure(result.code, combinedOutput);
  }

  const media = locateDownloadedMedia(outDir, expectedPath);
  if (!media) {
    throw createBiliError('yt-dlp 执行成功但未在输出目录找到有效 MP4 文件', 3);
  }

  if (media.sizeBytes > MAX_BAILIAN_BYTES) {
    const sizeMiB = (media.sizeBytes / (1024 ** 2)).toFixed(1);
    throw createBiliError(
      `下载视频体积 ${sizeMiB} MiB 超过百炼 1 GiB 上限，请改用 --quality 480 / 360 或 --clip 切片`,
      3,
    );
  }

  return {
    filePath: media.filePath,
    sizeBytes: media.sizeBytes,
    downloadMs: Date.now() - startedAt,
  };
}
