import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_TTL_MS,
  DEFAULT_CACHE_FILE,
  buildCacheKey,
  getCachedOss,
  setCachedOss,
  deleteCachedOss,
} from '../src/cache.mjs';

import {
  SYSTEM_PROMPT,
  formatTimestamp,
  parseExplicitClip,
  detectTimeWindow,
  planVideoBudget,
  buildMessages,
} from '../src/prompt-builder.mjs';

import {
  CLEAN_ENV,
  redactSecrets,
  parseCredentialText,
  loadCredentials,
  createSseParser,
  feedSseChunk,
} from '../src/bailian.mjs';

import { parseBiliInput } from '../src/bilibili.mjs';

describe('cache.mjs', () => {
  it('exposes 42h TTL and standard default cache path', () => {
    assert.equal(DEFAULT_TTL_MS, 42 * 3600 * 1000);
    assert.ok(DEFAULT_CACHE_FILE.endsWith(path.join('.cache', 'bili-omni', 'index.json')));
  });

  it('builds 4-part cache key including model', () => {
    const key1 = buildCacheKey({
      bvid: 'BV16Xbm6VEzd',
      cid: 123456789,
      quality: 720,
      model: 'qwen3.8-omni-flash',
    });
    const key2 = buildCacheKey({
      bvid: 'BV16Xbm6VEzd',
      cid: 123456789,
      quality: 720,
      model: 'qwen3.5-omni-plus',
    });
    assert.equal(key1, 'BV16Xbm6VEzd:123456789:q720:qwen3.8-omni-flash');
    assert.notEqual(key1, key2);
    assert.throws(() => buildCacheKey({ bvid: 'BV16Xbm6VEzd', cid: 1, quality: 720 }));
  });

  it('sets, reads, expires, and deletes oss:// entries safely', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-cache-test-'));
    const cacheFile = path.join(tmpDir, 'nested', 'index.json');
    try {
      const params = {
        bvid: 'BV16Xbm6VEzd',
        cid: 998877,
        quality: 720,
        model: 'qwen3.8-omni-flash',
      };
      const otherParams = {
        bvid: 'BV16Xbm6VEzd',
        cid: 998877,
        quality: 480,
        model: 'qwen3.8-omni-flash',
      };

      assert.equal(getCachedOss(params, { cacheFile, now: 1000 }), null);

      setCachedOss(params, 'oss://bucket/v1.mp4', { cacheFile, ttlMs: 5000, now: 1000 });
      setCachedOss(otherParams, 'oss://bucket/v2.mp4', { cacheFile, ttlMs: 10000, now: 1000 });

      const hit = getCachedOss(params, { cacheFile, now: 5999 });
      assert.deepEqual(hit, {
        ossUri: 'oss://bucket/v1.mp4',
        createdAt: 1000,
        expiresAt: 6000,
        bvid: 'BV16Xbm6VEzd',
        cid: 998877,
        quality: 720,
        model: 'qwen3.8-omni-flash',
      });

      // Expired at now === expiresAt; other entry remains active.
      assert.equal(getCachedOss(params, { cacheFile, now: 6000 }), null);
      assert.equal(getCachedOss(otherParams, { cacheFile, now: 6000 })?.ossUri, 'oss://bucket/v2.mp4');

      assert.equal(deleteCachedOss(otherParams, { cacheFile }), true);
      assert.equal(deleteCachedOss(otherParams, { cacheFile }), false);
      assert.equal(getCachedOss(otherParams, { cacheFile, now: 6000 }), null);

      // Corrupted JSON does not crash lookups.
      fs.writeFileSync(cacheFile, '{corrupted', 'utf8');
      assert.equal(getCachedOss(params, { cacheFile, now: 2000 }), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('prompt-builder.mjs', () => {
  it('formats timestamps properly for <1h and >=1h', () => {
    assert.equal(formatTimestamp(0), '[00:00]');
    assert.equal(formatTimestamp(885), '[14:45]');
    assert.equal(formatTimestamp(2723), '[45:23]');
    assert.equal(formatTimestamp(3920), '[01:05:20]');
  });

  it('parses valid explicit clips and rejects invalid ones with exitCode 2', () => {
    assert.deepEqual(parseExplicitClip('14:50-15:30', 2723), { startSec: 890, endSec: 930 });
    assert.deepEqual(parseExplicitClip('900-930', 2723), { startSec: 900, endSec: 930 });
    assert.deepEqual(parseExplicitClip('01:05:20-01:06:00', 4000), { startSec: 3920, endSec: 3960 });

    for (const bad of ['bad', '15:30-14:50', '900-900', '-10-20', '45:00-46:00', '10:00-14:00']) {
      assert.throws(
        () => parseExplicitClip(bad, 2723),
        (err) => err && err.exitCode === 2,
      );
    }
  });

  it('detects narrow time windows and expands padding accurately', () => {
    assert.deepEqual(detectTimeWindow('15:00画面右上角写了什么？', 2723), {
      startSec: 885,
      endSec: 925,
      rawSpanSec: 0,
    });
    assert.deepEqual(detectTimeWindow('15:00到15:20画面右上角、主标题和最左侧竖排小字写了什么？', 2723), {
      startSec: 890,
      endSec: 930,
      rawSpanSec: 20,
    });
    assert.deepEqual(detectTimeWindow('10:00-11:30讲了什么', 2723), {
      startSec: 590,
      endSec: 700,
      rawSpanSec: 90,
    });
    assert.deepEqual(detectTimeWindow('01:05:20这里有什么报错？', 4200), {
      startSec: 3905,
      endSec: 3945,
      rawSpanSec: 0,
    });
    assert.deepEqual(detectTimeWindow('14分50秒提到了什么工具？', 2723), {
      startSec: 875,
      endSec: 915,
      rawSpanSec: 0,
    });
    assert.deepEqual(detectTimeWindow('第15分钟展示了什么？', 2723), {
      startSec: 885,
      endSec: 925,
      rawSpanSec: 0,
    });
    assert.deepEqual(detectTimeWindow('10-12分钟有什么重点？', 2723), {
      startSec: 590,
      endSec: 730,
      rawSpanSec: 120,
    });
    assert.deepEqual(detectTimeWindow('16:9画幅下15:00画面写了啥？', 2723), {
      startSec: 885,
      endSec: 925,
      rawSpanSec: 0,
    });
    assert.deepEqual(detectTimeWindow('00:05开场字幕写了什么？', 2723), {
      startSec: 0,
      endSec: 30,
      rawSpanSec: 0,
    });
  });

  it('rejects ratios, scores, versions, out-of-range, whole-video, and wide multi-point spans', () => {
    const negatives = [
      ['16:9和3:2以及1:1画幅区别是什么？', 2723, {}],
      ['比例16:10或者9:16竖屏怎么看？', 2723, {}],
      ['这局比分12:30怎么逆转的？', 2723, {}],
      ['版本v1:20和v2.0:15有什么变化？', 2723, {}],
      ['满分10分的话给9分还是10分？', 2723, {}],
      ['99:00讲了什么？', 2723, {}],
      ['14:50-50:00发生了什么？', 2723, {}],
      ['20:00 与 36:30 分别讲了什么？', 2723, {}],
      ['全片总结一下，顺便看下15:00', 2723, {}],
      ['整期视频从头到尾梳理一遍 15:00', 2723, {}],
      ['15:00讲了啥？', 2723, { noClip: true }],
      ['15:00讲了啥？', 2723, { videoCount: 2 }],
      ['', 2723, {}],
    ];

    for (const [q, dur, opts] of negatives) {
      assert.equal(detectTimeWindow(q, dur, opts), null, `Expected null for: ${q}`);
    }
  });

  it('plans video token budget across short, 45m, 95m, multi-video, clip, and 3.5 vs 3.8 limits', () => {
    const shortPlan = planVideoBudget(600, { model: 'qwen3.8-omni-flash' });
    assert.equal(shortPlan.quality, 720);
    assert.equal(shortPlan.fps, 0.2);
    assert.equal(shortPlan.enableThinkingDefault, false);

    const midPlan = planVideoBudget(2723, { model: 'qwen3.8-omni-flash' });
    assert.equal(midPlan.quality, 720);
    assert.equal(midPlan.fps, 0.2);
    assert.ok(midPlan.estimatedTokens <= 240_000);

    const q35Plan = planVideoBudget(2723, { model: 'qwen3.5-omni-plus' });
    assert.equal(q35Plan.maxInputTokens, 185_000);
    assert.equal(q35Plan.targetBudgetTokens, 170_000);
    assert.ok(q35Plan.estimatedTokens <= 170_000);
    assert.ok(q35Plan.quality < 720 || q35Plan.fps < 0.2);

    const longPlan = planVideoBudget(5700, { model: 'qwen3.8-omni-flash' });
    assert.ok(longPlan.estimatedTokens <= 240_000);
    assert.ok(longPlan.quality < 720 || longPlan.fps < 0.2);

    const multiPlan = planVideoBudget([2723, 2723], { model: 'qwen3.8-omni-flash' });
    assert.ok(multiPlan.estimatedTokens <= 240_000);

    const clipPlan = planVideoBudget(40, { model: 'qwen3.8-omni-flash', isClip: true });
    assert.equal(clipPlan.quality, 1080);
    assert.equal(clipPlan.fps, 1.0);
    assert.equal(clipPlan.enableThinkingDefault, true);

    assert.throws(
      () => planVideoBudget(7500, { model: 'qwen3.8-omni-flash' }),
      (err) => err && err.exitCode === 2,
    );
    assert.throws(
      () => planVideoBudget(3700, { model: 'qwen3.5-omni-plus' }),
      (err) => err && err.exitCode === 2,
    );
  });

  it('builds messages in [video_url..., text] order with top-level fps and clip offset notice', () => {
    const meta1 = {
      bvid: 'BV16Xbm6VEzd',
      cid: 111,
      page: 1,
      totalPages: 1,
      partTitle: '为什么游戏设计师需要搭建自己的harness？',
      title: '为什么游戏设计师需要搭建自己的harness？',
      ownerName: '千水_Asteroid',
      durationSec: 2723,
      desc: '介绍 Nebula 与 BM25 检索。',
    };
    const meta2 = {
      bvid: 'BV1xx411c7mD',
      cid: 222,
      page: 2,
      totalPages: 3,
      partTitle: '第二集',
      title: '对比视频',
      ownerName: 'UP2',
      durationSec: 600,
      desc: '',
    };

    const clipMessages = buildMessages({
      items: [{ meta: meta1, ossUri: 'oss://bucket/clip.mp4', fps: 1.0 }],
      ask: '15:00到15:20写了什么？',
      clipInfo: { startSec: 885, endSec: 925 },
    });
    assert.equal(clipMessages[0].role, 'system');
    assert.equal(clipMessages[0].content, SYSTEM_PROMPT);
    assert.equal(clipMessages[1].role, 'user');
    assert.equal(clipMessages[1].content.length, 2);
    assert.deepEqual(clipMessages[1].content[0], {
      type: 'video_url',
      video_url: { url: 'oss://bucket/clip.mp4' },
      fps: 1.0,
    });
    assert.equal(clipMessages[1].content[1].type, 'text');
    assert.match(clipMessages[1].content[1].text, /当前视频为原片 \[14:45\] 至 \[15:25\] 的截取片段（起点偏移 \+885s），输出所有时间戳时必须加上起点 \[14:45\] 换算为原片绝对时间/);
    assert.match(clipMessages[1].content[1].text, /标题：为什么游戏设计师需要搭建自己的harness？/);

    const fullLongMessages = buildMessages({
      items: [{ meta: meta1, ossUri: 'oss://bucket/full.mp4', fps: 0.2 }],
    });
    assert.match(fullLongMessages[1].content[1].text, /完整覆盖全片开头、中段与结尾/);

    const multiShortMessages = buildMessages({
      items: [
        { meta: meta1, ossUri: 'oss://bucket/v1.mp4', fps: 0.2 },
        { meta: meta2, ossUri: 'oss://bucket/v2.mp4', fps: 0.2 },
      ],
      ask: '对比两者核心差异',
    });
    assert.equal(multiShortMessages[1].content.length, 3);
    assert.equal(multiShortMessages[1].content[0].type, 'video_url');
    assert.equal(multiShortMessages[1].content[1].type, 'video_url');
    assert.equal(multiShortMessages[1].content[2].type, 'text');
  });
});

describe('bailian.mjs', () => {
  it('strips all proxy env variables in CLEAN_ENV without mutating input', () => {
    const original = {
      PATH: 'C:\\Windows',
      HTTP_PROXY: 'http://127.0.0.1:7891',
      HTTPS_PROXY: 'http://127.0.0.1:7891',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      http_proxy: 'http://127.0.0.1:7891',
      https_proxy: 'http://127.0.0.1:7891',
      all_proxy: 'socks5://127.0.0.1:7891',
      NODE_USE_ENV_PROXY: '1',
      KEEP_ME: 'yes',
    };
    const cleaned = CLEAN_ENV(original);
    assert.equal(cleaned.PATH, 'C:\\Windows');
    assert.equal(cleaned.KEEP_ME, 'yes');
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NODE_USE_ENV_PROXY',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(cleaned, key), false);
      assert.equal(Object.prototype.hasOwnProperty.call(original, key), true);
    }
  });

  it('parses vertical key,value CSV and single-line credentials, and redacts secrets', () => {
    const fakeKey = ['sk', 'ws', 'dummy1234567890abcdef'].join('-');
    const csvText = [
      `\uFEFFapiKey,"${fakeKey}"`,
      'workspaceId,ws-demo-1',
      'dashScope,"https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1/"',
      'openAiCompatible,https://ws-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/',
    ].join('\r\n');

    const parsedCsv = parseCredentialText(csvText);
    assert.equal(parsedCsv.apiKey, fakeKey);
    assert.equal(parsedCsv.workspaceId, 'ws-demo-1');
    assert.equal(parsedCsv.dashScopeBase, 'https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1');
    assert.equal(
      parsedCsv.openAiBase,
      'https://ws-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );

    const parsedSingle = parseCredentialText(`  ${fakeKey} \n`);
    assert.equal(parsedSingle.apiKey, fakeKey);
    assert.equal(parsedSingle.dashScopeBase, 'https://dashscope.aliyuncs.com/api/v1');
    assert.equal(parsedSingle.openAiBase, 'https://dashscope.aliyuncs.com/compatible-mode/v1');

    const customSecret = 'my_custom_secret_token';
    const leaked = `Authorization: Bearer ${fakeKey}; extra=${customSecret}`;
    const masked = redactSecrets(leaked, [customSecret]);
    assert.equal(masked.includes(fakeKey), false);
    assert.equal(masked.includes(customSecret), false);
    assert.equal(masked, 'Authorization: Bearer <REDACTED>; extra=<REDACTED>');
  });

  it('loads credentials in priority order and throws exitCode 2 when missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-creds-test-'));
    try {
      const fakeKey1 = ['sk', 'explicit', '111122223333'].join('-');
      const fakeKey2 = ['sk', 'envval', '444455556666'].join('-');
      const fakeKey3 = ['sk', 'csvfile', '777788889999'].join('-');

      const configDir = path.join(tmpDir, 'cfg');
      const projectDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'demo-apiKey.csv'), `apiKey,${fakeKey3}\n`, 'utf8');

      assert.equal(
        loadCredentials({ explicitKey: fakeKey1, env: { DASHSCOPE_API_KEY: fakeKey2 }, configDir, projectDir }).apiKey,
        fakeKey1,
      );
      assert.equal(
        loadCredentials({ env: { BAILIAN_API_KEY: fakeKey2 }, configDir, projectDir }).apiKey,
        fakeKey2,
      );
      assert.equal(loadCredentials({ env: {}, configDir, projectDir }).apiKey, fakeKey3);

      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      assert.throws(
        () => loadCredentials({ env: {}, configDir: emptyDir, projectDir: emptyDir }),
        (err) => err && err.exitCode === 2,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses multi-chunk SSE streams with reasoning_content, content, usage, and [DONE]', () => {
    const state = createSseParser();
    const chunks = [
      ': keep-alive\n\ndata: {"choices":[{"delta":{"reasoning_content":"Think 1"}}]}\n',
      '\ndata: {"choices":[{"delta":{"reasoning_content":" + 2"}}]}\n\ndata: {"choices":[{"delta":{"con',
      'tent":"第四章"}}]}\n\ndata: {"choices":[{"delta":{"content":"：被电惯了的狗"},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":180747,"completion_tokens":42,"prompt_tokens_details":{"cached_tokens":180736}}}\n\n',
      'data: [DONE]\n\n',
    ];

    const collectedContent = [];
    const collectedReasoning = [];
    let lastRes = null;
    for (const chunk of chunks) {
      lastRes = feedSseChunk(state, chunk);
      if (lastRes.contentDelta) collectedContent.push(lastRes.contentDelta);
      if (lastRes.reasoningDelta) collectedReasoning.push(lastRes.reasoningDelta);
    }

    assert.equal(state.done, true);
    assert.equal(lastRes.done, true);
    assert.equal(state.finishReason, 'stop');
    assert.equal(state.reasoningContent, 'Think 1 + 2');
    assert.equal(collectedReasoning.join(''), 'Think 1 + 2');
    assert.equal(state.content, '第四章：被电惯了的狗');
    assert.equal(collectedContent.join(''), '第四章：被电惯了的狗');
    assert.deepEqual(state.usage, {
      prompt_tokens: 180747,
      completion_tokens: 42,
      prompt_tokens_details: { cached_tokens: 180736 },
    });
  });
});

describe('bilibili.mjs', () => {
  it('parses bare BV/av IDs, full URLs with ?p=N, tracking params, and explicit page overrides', () => {
    assert.deepEqual(parseBiliInput('BV16Xbm6VEzd'), {
      kind: 'video',
      bvid: 'BV16Xbm6VEzd',
      aid: null,
      page: 1,
    });
    assert.deepEqual(parseBiliInput('bv16Xbm6VEzd'), {
      kind: 'video',
      bvid: 'BV16Xbm6VEzd',
      aid: null,
      page: 1,
    });
    assert.deepEqual(parseBiliInput('av117101578688541'), {
      kind: 'video',
      bvid: null,
      aid: 117101578688541,
      page: 1,
    });
    assert.deepEqual(
      parseBiliInput(
        'https://www.bilibili.com/video/BV16Xbm6VEzd/?p=2&spm_id_from=333.337.search-card.all.click&vd_source=deadbeef',
      ),
      {
        kind: 'video',
        bvid: 'BV16Xbm6VEzd',
        aid: null,
        page: 2,
      },
    );
    assert.deepEqual(
      parseBiliInput('bilibili.com/video/av170001?p=3&share_source=copy_web'),
      {
        kind: 'video',
        bvid: null,
        aid: 170001,
        page: 3,
      },
    );
    assert.deepEqual(
      parseBiliInput('https://www.bilibili.com/video/BV16Xbm6VEzd?p=2', 5),
      {
        kind: 'video',
        bvid: 'BV16Xbm6VEzd',
        aid: null,
        page: 5,
      },
    );
  });

  it('parses b23.tv short links and strips tracking query params', () => {
    assert.deepEqual(parseBiliInput('https://b23.tv/abc123?p=2&share_medium=android'), {
      kind: 'short',
      shortUrl: 'https://b23.tv/abc123',
      explicitPage: 2,
    });
    assert.deepEqual(parseBiliInput('b23.tv/BV16Xbm6VEzd', 3), {
      kind: 'short',
      shortUrl: 'https://b23.tv/BV16Xbm6VEzd',
      explicitPage: 3,
    });
  });

  it('rejects invalid inputs and invalid page numbers with exitCode 2', () => {
    const invalidInputs = [
      [''],
      ['   '],
      ['invalid_input_123'],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
      ['https://www.bilibili.com/'],
      ['https://b23.tv/'],
      ['BV123'],
      ['av0'],
      ['https://www.bilibili.com/video/BV16Xbm6VEzd?p=0'],
      ['BV16Xbm6VEzd', 0],
      ['BV16Xbm6VEzd', -2],
      ['BV16Xbm6VEzd', 'abc'],
    ];
    for (const [input, page] of invalidInputs) {
      assert.throws(
        () => parseBiliInput(input, page),
        (err) => err && err.exitCode === 2,
        `Expected exitCode 2 for input=${String(input)} page=${String(page)}`,
      );
    }
  });
});
