import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { redactSecrets } from '../src/bailian.mjs';
import { getCachedOss } from '../src/cache.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'src', 'cli.mjs');

const GATE_B_MAX_MS = 90_000;
const GATE_A_MAX_MS = 45_000; // Calibrated by Phase 0 spike (fps=1.0, thinking=true: 24.49s-32.97s)

function runCli(args, { timeoutMs = 150_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: redactSecrets(`${stderr}\n${err.message}`),
        json: null,
        wallMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr: redactSecrets(stderr),
        json,
        wallMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

function extractTimestampsSec(text) {
  if (typeof text !== 'string') return [];
  const results = [];
  const re = /(?<!\d)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?!\d)/g;
  for (const m of text.matchAll(re)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = m[3] !== undefined ? Number(m[3]) : null;
    if (c !== null) {
      results.push(a * 3600 + b * 60 + c);
    } else {
      results.push(a * 60 + b);
    }
  }
  return results;
}

function evaluateGateB(res) {
  const j = res.json;
  const content = typeof j?.content === 'string' ? j.content : '';
  const timestamps = extractTimestampsSec(content);
  const minTs = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : null;

  const video0 = j?.videos?.[0] || null;
  const cachedEntry =
    video0?.bvid && video0?.cid && j?.quality && j?.model
      ? getCachedOss({
          bvid: video0.bvid,
          cid: video0.cid,
          quality: j.quality,
          model: j.model,
        })
      : null;

  const functionalChecks = {
    exitZero: res.exitCode === 0,
    okTrue: j?.ok === true,
    modeFull: j?.mode === 'full',
    under90s: typeof j?.timings?.totalMs === 'number' && j.timings.totalMs < GATE_B_MAX_MS,
    cacheMissFirstRun: j?.cacheHit === false,
    ossPersistedInCache:
      typeof video0?.ossUri === 'string' &&
      video0.ossUri.startsWith('oss://') &&
      cachedEntry?.ossUri === video0.ossUri,
    timestampsSpanFullVideo:
      minTs !== null && maxTs !== null && minTs <= 300 && maxTs >= 2040,
  };

  const qualityChecks = {
    hitsYouyou: content.includes('悠悠'),
    noWrongYouyou: !content.includes('优优'),
    hitsNebula: /nebula/i.test(content),
    hitsBm25: /bm25/i.test(content),
  };

  return {
    functionalPass: Object.values(functionalChecks).every(Boolean),
    functionalChecks,
    qualityPass: Object.values(qualityChecks).every(Boolean),
    qualityChecks,
    metrics: {
      wallMs: res.wallMs,
      totalMs: j?.timings?.totalMs ?? null,
      downloadMs: j?.timings?.downloadMs ?? null,
      uploadMs: j?.timings?.uploadMs ?? null,
      ttftMs: j?.timings?.ttftMs ?? null,
      inferenceMs: j?.timings?.inferenceMs ?? null,
      minTimestampSec: minTs,
      maxTimestampSec: maxTs,
      timestampCount: timestamps.length,
      usage: j?.usage ?? null,
    },
    errorTail: res.exitCode !== 0 ? redactSecrets(res.stderr.slice(-500)) : null,
  };
}

function listsFivePrinciples(content) {
  if (typeof content !== 'string' || content.trim().length < 30) return false;
  const numberedMatches = content.match(/(?:^|\n)\s*(?:\*{0,2})[1-5][\.、\):：\s]/gm) || [];
  if (numberedMatches.length >= 5) return true;
  const bulletMatches = content.match(/(?:^|\n)\s*[-*•]\s+\S/gm) || [];
  if (bulletMatches.length >= 5) return true;
  const hasDigits1to5 = ['1', '2', '3', '4', '5'].every((d) => content.includes(d));
  const hasChinese1to5 = ['一', '二', '三', '四', '五'].every((c) => content.includes(c));
  return hasDigits1to5 || hasChinese1to5;
}

function evaluateGateC(res) {
  const j = res.json;
  const content = typeof j?.content === 'string' ? j.content : '';
  const cachedTokens = j?.usage?.prompt_tokens_details?.cached_tokens ?? null;

  const functionalChecks = {
    exitZero: res.exitCode === 0,
    okTrue: j?.ok === true,
    cacheHitTrue: j?.cacheHit === true,
    zeroDownloadMs: j?.timings?.downloadMs === 0,
    zeroUploadMs: j?.timings?.uploadMs === 0,
    listsFivePrinciples: listsFivePrinciples(content),
  };

  return {
    functionalPass: Object.values(functionalChecks).every(Boolean),
    functionalChecks,
    observation: {
      cachedTokens,
      prefixCacheGt150k: typeof cachedTokens === 'number' && cachedTokens > 150_000,
    },
    metrics: {
      wallMs: res.wallMs,
      totalMs: j?.timings?.totalMs ?? null,
      downloadMs: j?.timings?.downloadMs ?? null,
      uploadMs: j?.timings?.uploadMs ?? null,
      ttftMs: j?.timings?.ttftMs ?? null,
      inferenceMs: j?.timings?.inferenceMs ?? null,
      usage: j?.usage ?? null,
    },
    errorTail: res.exitCode !== 0 ? redactSecrets(res.stderr.slice(-500)) : null,
  };
}

function evaluateGateA(res) {
  const j = res.json;
  const content = typeof j?.content === 'string' ? j.content : '';
  const timestamps = extractTimestampsSec(content);
  const hasUnshifted00 =
    /\b00:[1-3]\d\b/.test(content) || timestamps.some((sec) => sec >= 10 && sec <= 39);
  const hasShifted15xx = timestamps.some((sec) => sec >= 885 && sec <= 925);

  const functionalChecks = {
    exitZero: res.exitCode === 0,
    okTrue: j?.ok === true,
    modeClip: j?.mode === 'clip',
    withinCalibratedLatency:
      typeof j?.timings?.totalMs === 'number' && j.timings.totalMs <= GATE_A_MAX_MS,
    hitsChapter4: content.includes('第四章'),
    hitsDogTitle: content.includes('被电惯了的狗'),
    hitsVerticalText: /关于\s*AI|VOL\.?\s*3\d/i.test(content),
    noUnshiftedTimestamps: !hasUnshifted00,
    timestampsValidIfPresent: timestamps.length === 0 || hasShifted15xx,
  };

  return {
    functionalPass: Object.values(functionalChecks).every(Boolean),
    functionalChecks,
    metrics: {
      wallMs: res.wallMs,
      totalMs: j?.timings?.totalMs ?? null,
      downloadMs: j?.timings?.downloadMs ?? null,
      uploadMs: j?.timings?.uploadMs ?? null,
      ttftMs: j?.timings?.ttftMs ?? null,
      inferenceMs: j?.timings?.inferenceMs ?? null,
      timestampsSec: timestamps,
      hasShifted15xx,
      usage: j?.usage ?? null,
      contentPreview: redactSecrets(content.slice(0, 400)),
    },
    errorTail: res.exitCode !== 0 ? redactSecrets(res.stderr.slice(-500)) : null,
  };
}

function findLeftoverArtifacts(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tmp') {
        found.push(fullPath);
      }
      found.push(...findLeftoverArtifacts(fullPath));
    } else if (/\.mp4$/i.test(entry.name)) {
      found.push(fullPath);
    }
  }
  return found;
}

async function main() {
  const report = {
    order: ['Gate B', 'Gate C', 'Gate A'],
    gateB: null,
    gateC: null,
    gateA: null,
    workspaceClean: false,
    allHardGatesPassed: false,
  };

  // 1. Gate B: 45min full summary (--no-cache writes fresh oss:// cache for Gate C)
  process.stderr.write('[E2E] Running Gate B (45min full summary, --no-cache)...\n');
  const gateBArgs = ['BV16Xbm6VEzd', '--no-cache', '--json'];
  const gateBAttempt1Res = await runCli(gateBArgs);
  const gateBAttempt1 = evaluateGateB(gateBAttempt1Res);

  let gateBFinal = {
    ...gateBAttempt1,
    attempts: 1,
    attempt1QualityPass: gateBAttempt1.qualityPass,
    attempt2QualityPass: null,
  };

  if (gateBAttempt1.functionalPass && !gateBAttempt1.qualityPass) {
    process.stderr.write('[E2E] Gate B quality check missed on attempt 1; retrying once...\n');
    const gateBAttempt2Res = await runCli(gateBArgs);
    const gateBAttempt2 = evaluateGateB(gateBAttempt2Res);
    gateBFinal = {
      ...gateBAttempt2,
      attempts: 2,
      attempt1QualityPass: gateBAttempt1.qualityPass,
      attempt2QualityPass: gateBAttempt2.qualityPass,
      qualityPass: gateBAttempt1.qualityPass || gateBAttempt2.qualityPass,
    };
  }
  report.gateB = gateBFinal;

  // 2. Gate C: Same-video cached follow-up + Prefix Cache observation
  process.stderr.write('[E2E] Running Gate C (cached follow-up + Prefix Cache)...\n');
  const gateCRes = await runCli([
    'BV16Xbm6VEzd',
    '--no-clip',
    '-q',
    '第七章讲白盒骨架有哪五条原理？',
    '--json',
  ]);
  report.gateC = evaluateGateC(gateCRes);

  // 3. Gate A: High-res clip fast-path despite existing full-video cache
  process.stderr.write('[E2E] Running Gate A (clip fast-path despite full cache)...\n');
  const gateARes = await runCli([
    'BV16Xbm6VEzd',
    '-q',
    '15:00到15:20画面右上角、主标题和最左侧竖排小字写了什么？',
    '--json',
  ]);
  report.gateA = evaluateGateA(gateARes);

  const leftovers = findLeftoverArtifacts(PROJECT_ROOT);
  report.workspaceClean = leftovers.length === 0;
  report.leftoverArtifacts = leftovers;

  report.allHardGatesPassed = Boolean(
    report.gateB?.functionalPass &&
    report.gateC?.functionalPass &&
    report.gateA?.functionalPass &&
    report.workspaceClean,
  );

  const summaryText = redactSecrets(JSON.stringify(report, null, 2));
  process.stdout.write(`${summaryText}\n`);
  process.exitCode = report.allHardGatesPassed ? 0 : 1;
}

await main();
