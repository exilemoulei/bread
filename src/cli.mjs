#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIRECT_HTTPS_AGENT,
  loadCredentials,
  uploadToBailianOss,
  chatWithBailian,
  redactSecrets,
} from './bailian.mjs';
import {
  parseBiliInput,
  resolveVideoTarget,
  downloadBiliMedia,
} from './bilibili.mjs';
import {
  getCachedOss,
  setCachedOss,
  deleteCachedOss,
} from './cache.mjs';
import {
  formatTimestamp,
  parseExplicitClip,
  detectTimeWindow,
  planVideoBudget,
  buildMessages,
} from './prompt-builder.mjs';

const DEFAULT_MODEL = 'qwen3.8-omni-flash';
const CLIP_DEFAULT_FPS = 1.0;
const VALID_QUALITIES = new Set([1080, 720, 480, 360]);

function createCliError(message, exitCode) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

function getHelpText() {
  return `用法: bili <url|BV|av> [更多 url...] [选项]

位置参数:
  <url|BV|av>                   支持 bilibili.com/video/BV... (含 ?p=N)、裸 BV1.../av...、b23.tv 短链；支持传多个视频对比

选项:
  -q, --ask <text>              自定义问题（单视频含 <=180s 窄时间窗且未传 --no-clip 时自动走高清切片快路径）
  -p, --page <N>                指定分 P 序号（默认读取 URL 中的 ?p=N，无则为 1）
  --deep                        开启深度思考模式（全片开启 enable_thinking:true 输出详尽逐节推导）
  --clip <start-end>            显式截取指定时间段（如 "14:50-15:30" 或 "900-930"），默认 1080p + fps=1.0 + 开思考
  --no-clip                     即使 -q 含有时间点，也强制拉取并分析全片
  --quality <1080|720|480|360>  视频画质上限（全片按预算从 720 起步自适应；切片默认 1080）
  --fps <num>                   覆盖视频抽帧率（全片从 0.2 起步自适应；切片默认 1.0）
  --model <id>                  模型 ID（默认 ${DEFAULT_MODEL}）
  --no-cache                    忽略本地已有 oss:// 缓存，强制重新拉流上传（仍会刷新写入缓存）
  --cookies <browser|file>      透传给 yt-dlp（如 edge / chrome 或 cookies.txt 路径）
  --key <key>                   显式传入百炼 API Key
  --json                        输出结构化 JSON（含视频元数据、缓存命中、分阶段耗时、token usage 与正文）
  --out <file>                  将结果以 UTF-8 写入指定文件
  -h, --help                    显示本帮助信息

退出码:
  0  成功
  2  参数错误、校验失败或缺少 API Key
  3  B 站拉流失败或百炼 API 报错
  4  请求超时`;
}

function takeOptionValue(argv, index, flag, inlineValue) {
  if (inlineValue !== null) {
    return { value: inlineValue, nextIndex: index };
  }
  if (index + 1 >= argv.length) {
    throw createCliError(`选项 ${flag} 缺少参数值`, 2);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

export function parseArgs(argv) {
  const opts = {
    targets: [],
    ask: '',
    page: null,
    deep: false,
    clip: '',
    noClip: false,
    quality: null,
    fps: null,
    model: DEFAULT_MODEL,
    noCache: false,
    cookies: '',
    key: '',
    json: false,
    out: '',
    help: false,
  };

  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (positionalOnly) {
      opts.targets.push(raw);
      continue;
    }
    if (raw === '--') {
      positionalOnly = true;
      continue;
    }
    if (raw === '-h' || raw === '--help') {
      opts.help = true;
      return opts;
    }
    if (!raw.startsWith('-') || raw === '-') {
      opts.targets.push(raw);
      continue;
    }

    const eqIdx = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineValue = eqIdx !== -1 ? raw.slice(eqIdx + 1) : null;

    switch (flag) {
      case '-q':
      case '--ask': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        opts.ask = res.value;
        i = res.nextIndex;
        break;
      }
      case '-p':
      case '--page': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        const trimmed = String(res.value).trim();
        if (!/^[1-9]\d*$/.test(trimmed)) {
          throw createCliError(`无效的 ${flag} 分 P 序号 "${res.value}"：必须是 >= 1 的正整数`, 2);
        }
        const pageNum = Number(trimmed);
        if (!Number.isSafeInteger(pageNum) || pageNum < 1) {
          throw createCliError(`无效的 ${flag} 分 P 序号 "${res.value}"：超出安全整数范围`, 2);
        }
        opts.page = pageNum;
        i = res.nextIndex;
        break;
      }
      case '--deep':
        if (inlineValue !== null) throw createCliError(`选项 ${flag} 不接受参数值`, 2);
        opts.deep = true;
        break;
      case '--clip': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        if (!String(res.value).trim()) {
          throw createCliError('选项 --clip 不能为空，格式如 14:50-15:30 或 900-930', 2);
        }
        opts.clip = res.value;
        i = res.nextIndex;
        break;
      }
      case '--no-clip':
        if (inlineValue !== null) throw createCliError(`选项 ${flag} 不接受参数值`, 2);
        opts.noClip = true;
        break;
      case '--quality': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        const q = Number(res.value);
        if (!VALID_QUALITIES.has(q)) {
          throw createCliError(`不支持的 --quality "${res.value}"，可选值：1080, 720, 480, 360`, 2);
        }
        opts.quality = q;
        i = res.nextIndex;
        break;
      }
      case '--fps': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        const f = Number(res.value);
        if (!String(res.value).trim() || !Number.isFinite(f) || f <= 0) {
          throw createCliError(`无效的 --fps 参数 "${res.value}"：必须为大于 0 的数字`, 2);
        }
        opts.fps = f;
        i = res.nextIndex;
        break;
      }
      case '--model': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        const model = String(res.value).trim();
        if (!model) {
          throw createCliError('选项 --model 不能为空', 2);
        }
        opts.model = model;
        i = res.nextIndex;
        break;
      }
      case '--no-cache':
        if (inlineValue !== null) throw createCliError(`选项 ${flag} 不接受参数值`, 2);
        opts.noCache = true;
        break;
      case '--cookies': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        if (!String(res.value).trim()) {
          throw createCliError('选项 --cookies 不能为空', 2);
        }
        opts.cookies = res.value;
        i = res.nextIndex;
        break;
      }
      case '--key': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        if (!String(res.value).trim()) {
          throw createCliError('选项 --key 不能为空', 2);
        }
        opts.key = res.value;
        i = res.nextIndex;
        break;
      }
      case '--json':
        if (inlineValue !== null) throw createCliError(`选项 ${flag} 不接受参数值`, 2);
        opts.json = true;
        break;
      case '--out': {
        const res = takeOptionValue(argv, i, flag, inlineValue);
        if (!String(res.value).trim()) {
          throw createCliError('选项 --out 不能为空', 2);
        }
        opts.out = res.value;
        i = res.nextIndex;
        break;
      }
      default:
        throw createCliError(`未知选项: ${flag}（使用 --help 查看支持的选项）`, 2);
    }
  }

  if (opts.targets.length === 0) {
    throw createCliError('缺少视频参数：请提供至少一个 B 站 URL、BV 号或 av 号（使用 --help 查看用法）', 2);
  }
  if (opts.clip && opts.noClip) {
    throw createCliError('--clip 与 --no-clip 不能同时使用', 2);
  }
  if (opts.clip && opts.targets.length > 1) {
    throw createCliError('--clip 仅支持单个视频，不支持多视频同时切片', 2);
  }

  return opts;
}

async function downloadAndUpload({ meta, quality, clipRange, cookies, creds, model }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-omni-'));
  try {
    const dl = await downloadBiliMedia(meta, {
      quality,
      clipRange,
      cookies,
      outDir: tmpDir,
    });
    const up = await uploadToBailianOss(dl.filePath, {
      creds,
      model,
    });
    return {
      ossUri: up.ossUri,
      downloadMs: dl.downloadMs,
      uploadMs: up.uploadMs,
      sizeBytes: up.sizeBytes,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function formatSourceSummary(metas) {
  return metas
    .map((m) => {
      const id = m.bvid ? `${m.bvid}${m.totalPages > 1 ? `?p=${m.page}` : ''}` : m.canonicalUrl;
      return m.title ? `${id} (${m.title})` : id;
    })
    .join(' , ');
}

function writeOutFile(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
}

function resolveExitCode(err) {
  if (err?.isTimeout || err?.code === 'ETIMEDOUT' || err?.exitCode === 4) return 4;
  if (err?.exitCode === 2) return 2;
  if (err?.exitCode === 3) return 3;
  return 3;
}

async function main() {
  const totalStartedAt = Date.now();
  let opts = null;
  let creds = null;
  const getSecrets = () => [opts?.key, creds?.apiKey].filter(Boolean);
  const logStage = (msg) => {
    if (opts?.json) return;
    const elapsed = ((Date.now() - totalStartedAt) / 1000).toFixed(1);
    process.stderr.write(`[bili +${elapsed}s] ${redactSecrets(msg, getSecrets())}\n`);
  };

  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(`${getHelpText()}\n`);
      return;
    }

    // Fail fast on syntactically invalid Bilibili targets before credential/network I/O.
    for (const target of opts.targets) {
      parseBiliInput(target, opts.page);
    }

    creds = loadCredentials({ explicitKey: opts.key });

    const resolveStartedAt = Date.now();
    const metas = await Promise.all(
      opts.targets.map((target) => resolveVideoTarget(target, { page: opts.page })),
    );
    const resolveMs = Date.now() - resolveStartedAt;

    let clipInfo = null;
    if (opts.clip) {
      clipInfo = parseExplicitClip(opts.clip, metas[0].durationSec);
    } else if (metas.length === 1 && !opts.noClip && opts.ask) {
      clipInfo = detectTimeWindow(opts.ask, metas[0].durationSec, {
        videoCount: metas.length,
        noClip: opts.noClip,
      });
    }

    const isClip = Boolean(clipInfo);
    const mode = isClip ? 'clip' : 'full';
    const clipRange = isClip ? { startSec: clipInfo.startSec, endSec: clipInfo.endSec } : null;

    const budgetDurations = isClip
      ? [clipInfo.endSec - clipInfo.startSec]
      : metas.map((m) => m.durationSec);

    const budget = planVideoBudget(budgetDurations, {
      model: opts.model,
      explicitQuality: opts.quality,
      explicitFps: opts.fps,
      isClip,
      clipDefaultFps: CLIP_DEFAULT_FPS,
    });

    const enableThinking = opts.deep ? true : budget.enableThinkingDefault;
    logStage(
      `元数据解析完成 (${metas.length} 个视频, 模式=${isClip ? '切片' : '全片'} ${budget.quality}p @ ${budget.fps}fps${enableThinking ? ', deep' : ''})`,
    );

    let downloadMs = 0;
    let uploadMs = 0;
    const items = [];

    for (const meta of metas) {
      if (isClip) {
        logStage(`开始拉流与上传切片: ${meta.bvid} P${meta.page}…`);
        const res = await downloadAndUpload({
          meta,
          quality: budget.quality,
          clipRange,
          cookies: opts.cookies,
          creds,
          model: opts.model,
        });
        downloadMs += res.downloadMs;
        uploadMs += res.uploadMs;
        logStage(
          `切片就绪: 下载 ${(res.downloadMs / 1000).toFixed(1)}s, 上传 ${(res.uploadMs / 1000).toFixed(1)}s (${(res.sizeBytes / 1048576).toFixed(1)} MiB)`,
        );
        items.push({
          meta,
          ossUri: res.ossUri,
          fps: budget.fps,
          cacheHit: false,
        });
        continue;
      }

      const cacheParams = {
        bvid: meta.bvid,
        cid: meta.cid,
        quality: budget.quality,
        model: opts.model,
      };
      const cached = opts.noCache ? null : getCachedOss(cacheParams);
      if (cached?.ossUri) {
        logStage(`命中全片缓存: ${meta.bvid} P${meta.page}`);
        items.push({
          meta,
          ossUri: cached.ossUri,
          fps: budget.fps,
          cacheHit: true,
        });
        continue;
      }

      logStage(`开始拉流与上传全片: ${meta.bvid} P${meta.page} (${budget.quality}p)…`);
      const res = await downloadAndUpload({
        meta,
        quality: budget.quality,
        clipRange: null,
        cookies: opts.cookies,
        creds,
        model: opts.model,
      });
      downloadMs += res.downloadMs;
      uploadMs += res.uploadMs;
      logStage(
        `全片上传完成: 下载 ${(res.downloadMs / 1000).toFixed(1)}s, 上传 ${(res.uploadMs / 1000).toFixed(1)}s (${(res.sizeBytes / 1048576).toFixed(1)} MiB)`,
      );
      setCachedOss(cacheParams, res.ossUri);
      items.push({
        meta,
        ossUri: res.ossUri,
        fps: budget.fps,
        cacheHit: false,
      });
    }

    let messages = buildMessages({
      items,
      ask: opts.ask,
      clipInfo: clipRange,
    });

    let firstDeltaLogged = false;
    const onDeltaStage = () => {
      if (!firstDeltaLogged) {
        firstDeltaLogged = true;
        logStage('百炼首包已返回，正在接收流式输出…');
      }
    };

    let chatResult;
    try {
      chatResult = await chatWithBailian({
        creds,
        model: opts.model,
        messages,
        enableThinking,
        onContentDelta: onDeltaStage,
      });
    } catch (err) {
      const hasCachedItem = !isClip && items.some((it) => it.cacheHit);
      if (err?.ossExpired && hasCachedItem) {
        process.stderr.write('[缓存自愈] 检测到 cached oss:// 已失效，清理后重新拉流上传重试…\n');
        for (const item of items) {
          if (!item.cacheHit) continue;
          const cacheParams = {
            bvid: item.meta.bvid,
            cid: item.meta.cid,
            quality: budget.quality,
            model: opts.model,
          };
          deleteCachedOss(cacheParams);
          logStage(`开始重拉与重传: ${item.meta.bvid} P${item.meta.page}…`);
          const res = await downloadAndUpload({
            meta: item.meta,
            quality: budget.quality,
            clipRange: null,
            cookies: opts.cookies,
            creds,
            model: opts.model,
          });
          downloadMs += res.downloadMs;
          uploadMs += res.uploadMs;
          logStage(
            `自愈上传完成: 下载 ${(res.downloadMs / 1000).toFixed(1)}s, 上传 ${(res.uploadMs / 1000).toFixed(1)}s`,
          );
          setCachedOss(cacheParams, res.ossUri);
          item.ossUri = res.ossUri;
          item.cacheHit = false;
        }
        messages = buildMessages({
          items,
          ask: opts.ask,
          clipInfo: null,
        });
        firstDeltaLogged = false;
        chatResult = await chatWithBailian({
          creds,
          model: opts.model,
          messages,
          enableThinking,
          onContentDelta: onDeltaStage,
        });
      } else {
        throw err;
      }
    }

    if (!chatResult?.content || !chatResult.content.trim()) {
      throw createCliError('百炼接口返回成功，但未解析出有效回答文本。', 3);
    }

    const totalMs = Date.now() - totalStartedAt;
    const cacheHit = !isClip && items.every((it) => it.cacheHit);

    if (opts.json) {
      const payload = {
        ok: true,
        mode,
        model: opts.model,
        quality: budget.quality,
        fps: budget.fps,
        enableThinking,
        cacheHit,
        videos: items.map((it) => ({
          bvid: it.meta.bvid,
          aid: it.meta.aid,
          cid: it.meta.cid,
          page: it.meta.page,
          totalPages: it.meta.totalPages,
          title: it.meta.title,
          partTitle: it.meta.partTitle,
          ownerName: it.meta.ownerName,
          durationSec: it.meta.durationSec,
          canonicalUrl: it.meta.canonicalUrl,
          ossUri: it.ossUri,
          cacheHit: it.cacheHit,
        })),
        clip: clipRange,
        timings: {
          resolveMs,
          downloadMs,
          uploadMs,
          ttftMs: chatResult.ttftMs,
          inferenceMs: chatResult.inferenceMs,
          totalMs,
        },
        usage: chatResult.usage,
        content: chatResult.content,
        reasoningContent: chatResult.reasoningContent,
      };
      const serialized = redactSecrets(JSON.stringify(payload, null, 2), getSecrets());
      if (opts.out) {
        writeOutFile(opts.out, `${serialized}\n`);
      } else {
        process.stdout.write(`${serialized}\n`);
      }
      return;
    }

    const sourceLabel = formatSourceSummary(metas);
    const modeLabel = isClip
      ? `切片 ${formatTimestamp(clipInfo.startSec)}-${formatTimestamp(clipInfo.endSec)} (${budget.quality}p, ${budget.fps}fps)`
      : `全片 (${budget.quality}p, ${budget.fps}fps${cacheHit ? ', 缓存命中' : ''})`;
    const modelLabel = enableThinking ? `${opts.model} [deep]` : opts.model;
    const totalSec = (totalMs / 1000).toFixed(1);
    const dlSec = (downloadMs / 1000).toFixed(1);
    const upSec = (uploadMs / 1000).toFixed(1);

    const header = `来源: ${sourceLabel} | 模型: ${modelLabel} | 模式: ${modeLabel} | 耗时 ${totalSec}s (下载 ${dlSec}s, 上传 ${upSec}s)`;
    const output = redactSecrets(`${header}\n\n${chatResult.content.trim()}\n`, getSecrets());

    if (opts.out) {
      writeOutFile(opts.out, output);
      process.stdout.write(`已写入 ${opts.out}（${chatResult.content.trim().length} 字）\n`);
    } else {
      process.stdout.write(output);
    }
  } catch (err) {
    const code = resolveExitCode(err);
    const safeMsg = redactSecrets(err?.message || String(err), getSecrets());
    process.stderr.write(`错误: ${safeMsg}\n`);
    process.exitCode = code;
  } finally {
    DIRECT_HTTPS_AGENT?.destroy?.();
  }
}

function isDirectCliExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
  }
}

if (isDirectCliExecution()) {
  await main();
}
