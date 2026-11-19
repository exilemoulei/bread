export const SYSTEM_PROMPT = [
  '你是一个严谨的多模态视频分析助手，能够同时理解视频画面（文字、图表、代码、界面细节）与音轨语音。',
  '必须严格遵守以下规则：',
  '1. 严禁编造或脑补未在视频画面或音轨中出现的事实、数字、人物观点或小字内容；无法确认的内容直接回答“视频未提及”。',
  '2. 所有时间定位严格使用 [mm:ss] 格式（超过 1 小时可使用 [hh:mm:ss]），确保时间戳与视频真实进度一致。',
  '3. 专有名词、人名、产品名、英文术语、代码标识符、工具函数名必须原样保留，不得改写、翻译或替换为近义词（可参考元数据校准同音字，但不得照抄元数据里视频未讲到的内容）。',
  '4. 使用简洁、结构化、信息密度高的中文回答。',
].join('\n');

export const TOK_PER_FRAME = Object.freeze({
  1080: 520,
  720: 296,
  480: 180,
  360: 110,
});

export const AUDIO_TOK_PER_SEC = 7;

const MAX_CLIP_SPAN_SEC = 180;

const WHOLE_VIDEO_RE = /(?:全片|整期|整集|整部|完整总结|完整概括|完整梳理|完整回顾|全部内容|从头到尾)/;

const BEFORE_NEGATIVE_RE =
  /(?:比例|画幅|宽高比|长宽比|纵横比|缩放比|分辨率|比率|比分|比数|战绩|胜负|版本号?|aspect|ratio|v\d*\.?)\s*(?:为|是|按|:|：|=)?\s*$/i;

const AFTER_NEGATIVE_RE =
  /^\s*(?:的)?\s*(?:比例|画幅|宽高比|长宽比|纵横比|缩放比|分辨率|比率|比分|比数|竖屏|横屏|aspect|ratio)/i;

const SCORE_BEFORE_RE = /(?:满|打|扣|加|减|评|总|平均|得|获|拿|给|考)(?:了|到)?\s*(?:为|是)?\s*$/;
const SCORE_AFTER_RE = /^\s*(?:制|评分|评价|以上|以下)/;
const SCORE_CLAUSE_RE = /(?:满分|评分|打分|总分|得分|几分|多少分|(?:打|给|扣|得|拿|考)(?:了)?\s*\d+(?:\.\d+)?\s*分)/;

function makeError(message, exitCode) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

function formatClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) {
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Format integer seconds as `[mm:ss]` (or `[hh:mm:ss]` when `>= 3600`).
 */
export function formatTimestamp(sec) {
  return `[${formatClock(sec)}]`;
}

function parseSingleTimestampToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;

  let m = raw.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
  if (m) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  m = raw.match(/^(\d+):([0-5]\d)$/);
  if (m) {
    return Number(m[1]) * 60 + Number(m[2]);
  }

  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  return null;
}

/**
 * Parse an explicit `--clip <start-end>` specifier (e.g. `14:50-15:30`, `900-930`, `01:05:20-01:06:00`).
 */
export function parseExplicitClip(clipStr, durationSec) {
  if (typeof clipStr !== 'string' || !clipStr.trim()) {
    throw makeError('无效的 --clip 参数：不能为空，格式应为 start-end（如 14:50-15:30 或 900-930）。', 2);
  }
  const parts = clipStr.trim().split(/\s*(?:-|~|–|—|到|至)\s*/);
  if (parts.length !== 2) {
    throw makeError(`无效的 --clip 参数 "${clipStr}"：格式应为 start-end（如 14:50-15:30 或 900-930）。`, 2);
  }

  const startSec = parseSingleTimestampToken(parts[0]);
  const endSec = parseSingleTimestampToken(parts[1]);
  if (startSec === null || endSec === null) {
    throw makeError(`无效的 --clip 时间格式 "${clipStr}"：支持秒数、mm:ss 或 hh:mm:ss。`, 2);
  }
  if (startSec < 0 || startSec >= endSec) {
    throw makeError(`无效的 --clip 区间 "${clipStr}"：要求 0 <= start < end。`, 2);
  }
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 && endSec > durationSec) {
    throw makeError(
      `--clip 结束时间 (${endSec}s) 超出视频总时长 (${Math.floor(durationSec)}s)。`,
      2,
    );
  }
  if (endSec - startSec > MAX_CLIP_SPAN_SEC) {
    throw makeError(
      `--clip 区间跨度 (${endSec - startSec}s) 超过上限 ${MAX_CLIP_SPAN_SEC}s，请缩小区间或改用 --no-clip。`,
      2,
    );
  }
  return { startSec, endSec };
}

function hasNegativeContext(question, startIdx, endIdx, isBareMinute) {
  const before = question.slice(Math.max(0, startIdx - 18), startIdx);
  const after = question.slice(endIdx, Math.min(question.length, endIdx + 16));
  if (BEFORE_NEGATIVE_RE.test(before) || AFTER_NEGATIVE_RE.test(after)) {
    return true;
  }
  if (isBareMinute) {
    const clauseStart = Math.max(
      question.lastIndexOf('，', startIdx - 1),
      question.lastIndexOf(',', startIdx - 1),
      question.lastIndexOf('。', startIdx - 1),
      question.lastIndexOf('；', startIdx - 1),
      question.lastIndexOf('？', startIdx - 1),
      question.lastIndexOf('！', startIdx - 1),
      question.lastIndexOf('\n', startIdx - 1),
    ) + 1;
    const beforeClause = question.slice(clauseStart, startIdx);
    if (
      SCORE_BEFORE_RE.test(before) ||
      SCORE_AFTER_RE.test(after) ||
      SCORE_CLAUSE_RE.test(beforeClause)
    ) {
      return true;
    }
  }
  return false;
}

function collectTimeMentions(question) {
  const mentions = [];
  const occupied = [];

  const isOccupied = (start, end) =>
    occupied.some(([s, e]) => Math.max(s, start) < Math.min(e, end));

  const addMention = (start, end, sec, isMinuteOnly = false) => {
    if (isOccupied(start, end)) return;
    if (hasNegativeContext(question, start, end, isMinuteOnly)) return;
    occupied.push([start, end]);
    mentions.push({ start, end, sec, invalid: false });
  };

  // Shorthand minute ranges like "10-12分钟" or "10到12分".
  let nextRangeGroupId = 1;
  const shortMinRangeRe =
    /(?<![A-Za-z0-9_.:])(\d{1,4})\s*([-~–—到至])\s*(\d{1,4})\s*分(钟)?(?!\s*\d+\s*秒)(?![A-Za-z0-9_.:])/g;
  for (const m of question.matchAll(shortMinRangeRe)) {
    const start = m.index;
    const end = start + m[0].length;
    const isBareMinute = !m[4] && question[start - 1] !== '第';
    if (hasNegativeContext(question, start, end, isBareMinute)) continue;
    const sSec = Number(m[1]) * 60;
    const eSec = Number(m[3]) * 60;
    occupied.push([start, end]);
    const connectorOffset = m[0].indexOf(m[2]);
    const groupId = nextRangeGroupId++;
    mentions.push({ start, end: start + connectorOffset, sec: sSec, rangeGroupId: groupId });
    mentions.push({ start: start + connectorOffset + 1, end, sec: eSec, rangeGroupId: groupId });
  }

  // hh:mm:ss
  const hmsRe = /(?<![A-Za-z0-9_.:])(\d{1,2}):([0-5]\d):([0-5]\d)(?![A-Za-z0-9_.:])/g;
  for (const m of question.matchAll(hmsRe)) {
    const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    addMention(m.index, m.index + m[0].length, sec, false);
  }

  // mm:ss (strictly requires 2-digit seconds < 60, rejecting 16:9, 3:2, 1:1)
  const msRe = /(?<![A-Za-z0-9_.:])(\d{1,4}):([0-5]\d)(?![A-Za-z0-9_.:])/g;
  for (const m of question.matchAll(msRe)) {
    const sec = Number(m[1]) * 60 + Number(m[2]);
    addMention(m.index, m.index + m[0].length, sec, false);
  }

  // X小时Y分Z秒 / X分Y秒
  const cnFullRe =
    /(?<![A-Za-z0-9_.:])(?:(\d{1,2})\s*(?:小时|时)\s*)?(\d{1,4})\s*分(?:钟)?\s*([0-5]?\d)\s*秒(?![A-Za-z0-9_.:])/g;
  for (const m of question.matchAll(cnFullRe)) {
    const sec = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    addMention(m.index, m.index + m[0].length, sec, false);
  }

  // X小时Y分 / 第X分钟 / X分
  const cnMinRe =
    /(?<![A-Za-z0-9_.:])(?:(\d{1,2})\s*(?:小时|时)\s*)?(\d{1,4})\s*分(钟)?(?!\s*\d+\s*秒)(?![A-Za-z0-9_.:])/g;
  for (const m of question.matchAll(cnMinRe)) {
    const sec = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60;
    const isBareMinute = !m[1] && !m[3] && question[m.index - 1] !== '第';
    addMention(m.index, m.index + m[0].length, sec, isBareMinute);
  }

  mentions.sort((a, b) => a.start - b.start);
  return mentions;
}

/**
 * Detect whether a user question targets a narrow time window (`<= 180s`) suitable for high-res clipping.
 */
export function detectTimeWindow(question, durationSec, { videoCount = 1, noClip = false } = {}) {
  if (noClip || videoCount !== 1) return null;
  if (typeof question !== 'string' || !question.trim()) return null;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (WHOLE_VIDEO_RE.test(question)) return null;

  const mentions = collectTimeMentions(question);
  if (mentions.length === 0) return null;

  let hasExplicitRange = false;
  const pairedOutOfRange = new Set();

  for (let i = 0; i < mentions.length - 1; i++) {
    const cur = mentions[i];
    const next = mentions[i + 1];
    const between = question.slice(cur.end, next.start);
    const connectedAsRange =
      (cur.rangeGroupId !== undefined && cur.rangeGroupId === next.rangeGroupId) ||
      /^\s*(?:[-~–—到至]|and|to)\s*(?:第)?\s*$/i.test(between);
    if (connectedAsRange) {
      hasExplicitRange = true;
      if (cur.sec < 0 || cur.sec > durationSec || next.sec < 0 || next.sec > durationSec) {
        pairedOutOfRange.add(i);
        pairedOutOfRange.add(i + 1);
      }
    }
  }

  const validSecs = [];
  for (let i = 0; i < mentions.length; i++) {
    if (pairedOutOfRange.has(i)) continue;
    const { sec } = mentions[i];
    if (sec >= 0 && sec <= durationSec) {
      validSecs.push(sec);
    }
  }

  if (validSecs.length === 0) return null;

  const minSec = Math.min(...validSecs);
  const maxSec = Math.max(...validSecs);
  const rawSpanSec = maxSec - minSec;
  if (rawSpanSec > MAX_CLIP_SPAN_SEC) return null;

  let startSec;
  let endSec;
  if (rawSpanSec === 0 && !hasExplicitRange) {
    startSec = Math.max(0, minSec - 15);
    endSec = Math.min(durationSec, maxSec + 25);
  } else {
    startSec = Math.max(0, minSec - 10);
    endSec = Math.min(durationSec, maxSec + 10);
  }

  // Keep expanded window within 180s when rawSpanSec is close to 180s.
  if (endSec - startSec > MAX_CLIP_SPAN_SEC) {
    const spare = MAX_CLIP_SPAN_SEC - rawSpanSec;
    const beforePad = Math.floor(spare / 2);
    const afterPad = spare - beforePad;
    startSec = Math.max(0, minSec - beforePad);
    endSec = Math.min(durationSec, maxSec + afterPad);
  }

  startSec = Math.floor(startSec);
  endSec = Math.ceil(endSec);
  if (endSec > durationSec) endSec = Math.floor(durationSec);
  if (startSec >= endSec) return null;

  return { startSec, endSec, rawSpanSec };
}

function estimateTokens(durations, quality, fps) {
  const frameTok = TOK_PER_FRAME[quality];
  let total = 0;
  for (const dur of durations) {
    total += dur * fps * frameTok + dur * AUDIO_TOK_PER_SEC;
  }
  return Math.round(total);
}

/**
 * Plan video quality & sampling fps against Bailian model token limits.
 */
export function planVideoBudget(
  durationsSec,
  {
    model = 'qwen3.8-omni-flash',
    explicitQuality = null,
    explicitFps = null,
    isClip = false,
    clipDefaultFps = 1.0,
  } = {},
) {
  const durations = (Array.isArray(durationsSec) ? durationsSec : [durationsSec]).map(Number);
  if (durations.length === 0 || durations.some((d) => !Number.isFinite(d) || d <= 0)) {
    throw makeError('无效的视频时长：必须提供大于 0 的有效秒数。', 2);
  }

  const isQwen35 = String(model).toLowerCase().includes('3.5');
  const maxInputTokens = isQwen35 ? 185_000 : 950_000;
  const targetBudgetTokens = isQwen35 ? 170_000 : 240_000;
  const maxSingleVideoSec = isQwen35 ? 3600 : 7200;

  for (const dur of durations) {
    if (dur > maxSingleVideoSec) {
      throw makeError(
        `单个视频时长 (${Math.round(dur)}s) 超过模型 ${model} 的单文件上限 (${maxSingleVideoSec}s)。`,
        2,
      );
    }
  }

  let parsedQuality = null;
  if (explicitQuality !== null && explicitQuality !== undefined && explicitQuality !== '') {
    parsedQuality = Number(explicitQuality);
    if (!Object.prototype.hasOwnProperty.call(TOK_PER_FRAME, parsedQuality)) {
      throw makeError(`不支持的画质 "${explicitQuality}"，可选值：1080, 720, 480, 360。`, 2);
    }
  }

  let parsedFps = null;
  if (explicitFps !== null && explicitFps !== undefined && explicitFps !== '') {
    parsedFps = Number(explicitFps);
    if (!Number.isFinite(parsedFps) || parsedFps <= 0) {
      throw makeError(`无效的 --fps 参数 "${explicitFps}"：必须为大于 0 的数字。`, 2);
    }
  }

  const enableThinkingDefault = Boolean(isClip);

  if (isClip) {
    const qualityCandidates = parsedQuality !== null ? [parsedQuality] : [1080, 720, 480, 360];
    const baseClipFps = parsedFps !== null ? parsedFps : Number(clipDefaultFps);
    if (!Number.isFinite(baseClipFps) || baseClipFps <= 0) {
      throw makeError(`无效的切片 fps "${clipDefaultFps}"。`, 2);
    }
    const fpsCandidates =
      parsedFps !== null ? [parsedFps] : [...new Set([baseClipFps, 1.0, 0.5, 0.2].filter((f) => f <= baseClipFps))];

    let bestOverTarget = null;
    for (const q of qualityCandidates) {
      for (const fps of fpsCandidates) {
        const estimatedTokens = estimateTokens(durations, q, fps);
        if (estimatedTokens <= targetBudgetTokens) {
          return {
            quality: q,
            fps,
            estimatedTokens,
            maxInputTokens,
            targetBudgetTokens,
            enableThinkingDefault,
          };
        }
        if (
          estimatedTokens <= maxInputTokens &&
          (!bestOverTarget || estimatedTokens < bestOverTarget.estimatedTokens)
        ) {
          bestOverTarget = {
            quality: q,
            fps,
            estimatedTokens,
            maxInputTokens,
            targetBudgetTokens,
            enableThinkingDefault,
          };
        }
      }
    }
    if (bestOverTarget) return bestOverTarget;
    const minTokens = estimateTokens(
      durations,
      qualityCandidates[qualityCandidates.length - 1],
      fpsCandidates[fpsCandidates.length - 1],
    );
    throw makeError(
      `预估输入 tokens (${minTokens}) 超过模型 ${model} 上限 (${maxInputTokens})。`,
      2,
    );
  }

  // Full-video adaptive ladder: step down quality (720 -> 480 -> 360), then fps (0.2 -> 0.15 -> 0.1 -> 0.05).
  const qualitySteps = parsedQuality !== null ? [parsedQuality] : [720, 480, 360];
  const fpsSteps = parsedFps !== null ? [parsedFps] : [0.2, 0.15, 0.1, 0.05];

  const candidates = [];
  if (parsedQuality !== null && parsedFps !== null) {
    candidates.push([parsedQuality, parsedFps]);
  } else if (parsedQuality !== null) {
    for (const f of fpsSteps) candidates.push([parsedQuality, f]);
  } else if (parsedFps !== null) {
    for (const q of qualitySteps) candidates.push([q, parsedFps]);
  } else {
    for (const q of qualitySteps) candidates.push([q, fpsSteps[0]]);
    for (let i = 1; i < fpsSteps.length; i++) {
      candidates.push([qualitySteps[qualitySteps.length - 1], fpsSteps[i]]);
    }
  }

  for (const [q, fps] of candidates) {
    const estimatedTokens = estimateTokens(durations, q, fps);
    if (estimatedTokens <= targetBudgetTokens) {
      return {
        quality: q,
        fps,
        estimatedTokens,
        maxInputTokens,
        targetBudgetTokens,
        enableThinkingDefault,
      };
    }
  }

  // If user forced explicit flags or total duration exceeds soft target but fits hard limit, allow if <= maxInputTokens.
  const [minQ, minFps] = candidates[candidates.length - 1];
  const minEstimated = estimateTokens(durations, minQ, minFps);
  if (minEstimated <= maxInputTokens) {
    return {
      quality: minQ,
      fps: minFps,
      estimatedTokens: minEstimated,
      maxInputTokens,
      targetBudgetTokens,
      enableThinkingDefault,
    };
  }

  throw makeError(
    `预估输入 tokens (${minEstimated}) 超过模型 ${model} 最大输入上限 (${maxInputTokens})，请减少视频数量或调低 --quality / --fps。`,
    2,
  );
}

function formatMetaBlock(items) {
  const formatOne = (meta, prefix = '') => {
    const title = meta?.title || meta?.bvid || '未知';
    const owner = meta?.ownerName || '未知';
    const page = meta?.page ?? 1;
    const totalPages = meta?.totalPages ? `/${meta.totalPages}` : '';
    const partTitle = meta?.partTitle ? ` (${meta.partTitle})` : '';
    const part = `P${page}${totalPages}${partTitle}`;
    const durStr = formatClock(meta?.durationSec || 0);
    const rawDesc = String(meta?.desc || '').replace(/\s+/g, ' ').trim();
    const desc = rawDesc ? rawDesc.slice(0, 600) : '无';
    return `${prefix}标题：${title} | UP主：${owner} | 分P：${part} | 总时长：${durStr} | 简介摘录：${desc}`;
  };

  const header = '【视频已知元数据（仅供校准专有名词/人名同音字，严禁在画面/口播未提及时照抄简介编造内容）】';
  if (items.length === 1) {
    return `${header}${formatOne(items[0].meta)}`;
  }
  const lines = items.map((item, idx) => formatOne(item.meta, `视频${idx + 1}：`));
  return `${header}\n${lines.join('\n')}`;
}

function buildDefaultTaskPrompt(items) {
  const maxDurationSec = Math.max(...items.map((item) => Number(item?.meta?.durationSec) || 0));
  const multiNote = items.length > 1 ? '（同时结合并对比以上多个视频的内容）' : '';

  if (maxDurationSec < 900) {
    return [
      `请用中文输出这个视频的结构化汇总${multiNote}：`,
      '1. 一句话结论（它到底讲了什么）',
      '2. 5-9 条核心要点，每条前面标 [mm:ss] 时间戳',
      '3. 视频里出现的具体专有名词、人名、数字、代码或工具名（照原文保留，不要翻译成近义词）',
      '4. 如果视频有结论或行动建议，单列一节',
      '5. 你无法确认的地方直接说“视频未提及”，不要补充常识',
    ].join('\n');
  }

  return [
    `请用中文输出这个长视频的全片结构化汇总${multiNote}：`,
    '1. 一句话结论（它到底讲了什么）',
    '2. 按时间顺序完整覆盖全片开头、中段与结尾全部核心章节（从 [00:00] 到片尾，每章或核心转折至少 1 条 [mm:ss] 要点，严禁集中在前半段或提前截断）',
    '3. 视频里出现的具体专有名词、人名、数字、代码标识符或工具名（必须照原文精确拼写，不要翻译或改写为近义词）',
    '4. 如果视频有结论或行动建议，单列一节',
    '5. 你无法确认的地方直接说“视频未提及”，不要补充常识',
  ].join('\n');
}

/**
 * Assemble OpenAI-compatible Bailian messages with fixed prefix order (`[video_url..., text]`) for Prefix Cache hits.
 */
export function buildMessages({ items, ask = '', clipInfo = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw makeError('buildMessages 需要至少一个视频条目。', 2);
  }

  const videoParts = items.map((item) => ({
    type: 'video_url',
    video_url: { url: item.ossUri },
    fps: item.fps,
  }));

  const textSections = [formatMetaBlock(items)];

  if (clipInfo && typeof clipInfo.startSec === 'number' && typeof clipInfo.endSec === 'number') {
    const startLabel = formatTimestamp(clipInfo.startSec);
    const endLabel = formatTimestamp(clipInfo.endSec);
    textSections.push(
      `当前视频为原片 ${startLabel} 至 ${endLabel} 的截取片段（起点偏移 +${clipInfo.startSec}s），输出所有时间戳时必须加上起点 ${startLabel} 换算为原片绝对时间。`,
    );
  }

  const trimmedAsk = typeof ask === 'string' ? ask.trim() : '';
  textSections.push(trimmedAsk || buildDefaultTaskPrompt(items));

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...videoParts,
        { type: 'text', text: textSections.join('\n\n') },
      ],
    },
  ];
}
