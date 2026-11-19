import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_OPENAI_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
];

const PROXY_ENV_UPPER = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [3000, 6000, 12000];
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** Keep-alive direct HTTPS agent bypassing Node env proxy configuration. */
export const DIRECT_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16 });
const DIRECT_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16 });

/**
 * Return a shallow copy of env with proxy and Node env-proxy flags removed.
 */
export function CLEAN_ENV(baseEnv = process.env) {
  const cleaned = { ...(baseEnv || {}) };
  for (const key of PROXY_ENV_KEYS) {
    delete cleaned[key];
  }
  for (const key of Object.keys(cleaned)) {
    if (PROXY_ENV_UPPER.has(key.toUpperCase())) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function toPrintableString(input) {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return String(input);
  if (input instanceof Error) return input.stack || input.message || String(input);
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

/**
 * Redact explicit secrets (>= 6 chars) and API key patterns from arbitrary input.
 */
export function redactSecrets(input, extraSecrets = []) {
  let out = toPrintableString(input);
  const list = Array.isArray(extraSecrets) ? extraSecrets : extraSecrets ? [extraSecrets] : [];
  const normalized = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length >= 6 && trimmed !== '<REDACTED>') {
      normalized.push(trimmed);
    }
  }
  normalized.sort((a, b) => b.length - a.length);
  for (const secret of normalized) {
    if (out.includes(secret)) {
      out = out.split(secret).join('<REDACTED>');
    }
  }
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '<REDACTED>');
}

function createCodedError(message, exitCode, secrets = [], extra = {}) {
  const err = new Error(redactSecrets(message, secrets));
  err.exitCode = exitCode;
  Object.assign(err, extra);
  return err;
}

function stripQuotesAndBom(value) {
  let out = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length >= 2) ||
    (out.startsWith("'") && out.endsWith("'") && out.length >= 2)
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function splitCsvFields(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === quoteChar) {
        if (line[i + 1] === quoteChar) {
          current += ch;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if ((ch === '"' || ch === "'") && current.trim() === '') {
      current = '';
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function stripTrailingSlashes(urlText) {
  return String(urlText || '').replace(/\/+$/, '');
}

/**
 * Parse either a single-line API key or vertical `key,value` Bailian CSV text.
 */
export function parseCredentialText(text) {
  const result = {
    apiKey: '',
    dashScopeBase: DEFAULT_DASHSCOPE_BASE,
    openAiBase: DEFAULT_OPENAI_BASE,
    workspaceId: '',
  };
  if (typeof text !== 'string') return result;

  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) return result;

  for (const line of lines) {
    if (line.includes(',')) {
      const [rawKey = '', rawVal = ''] = splitCsvFields(line);
      const key = stripQuotesAndBom(rawKey).toLowerCase();
      const val = stripQuotesAndBom(rawVal);
      if (!val) continue;
      if (key === 'apikey' || key === 'api_key') {
        result.apiKey = val;
      } else if (key === 'dashscope' || key === 'dashscopebase' || key === 'dashscope_base') {
        result.dashScopeBase = stripTrailingSlashes(val) || DEFAULT_DASHSCOPE_BASE;
      } else if (
        key === 'openaicompatible' ||
        key === 'openaibase' ||
        key === 'openai_base' ||
        key === 'openai_compatible'
      ) {
        result.openAiBase = stripTrailingSlashes(val) || DEFAULT_OPENAI_BASE;
      } else if (key === 'workspaceid' || key === 'workspace_id') {
        result.workspaceId = val;
      }
      continue;
    }

    const cleaned = stripQuotesAndBom(line);
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex > 0) {
      const envKey = cleaned.slice(0, eqIndex).trim().toUpperCase();
      const envVal = stripQuotesAndBom(cleaned.slice(eqIndex + 1));
      if ((envKey === 'DASHSCOPE_API_KEY' || envKey === 'BAILIAN_API_KEY' || envKey === 'APIKEY') && envVal) {
        result.apiKey = envVal;
      }
      continue;
    }

    if (!result.apiKey || /^sk-/i.test(cleaned)) {
      result.apiKey = cleaned;
    }
  }

  return result;
}

function tryReadCredentialFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseCredentialText(raw);
    return parsed.apiKey ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load Bailian credentials from explicit key, environment, user config, or project CSV.
 */
export function loadCredentials({ explicitKey = '', env = process.env, configDir, projectDir } = {}) {
  const directKey = stripQuotesAndBom(explicitKey);
  if (directKey) {
    return {
      apiKey: directKey,
      dashScopeBase: DEFAULT_DASHSCOPE_BASE,
      openAiBase: DEFAULT_OPENAI_BASE,
      workspaceId: '',
    };
  }

  const envKey =
    stripQuotesAndBom(env?.DASHSCOPE_API_KEY) || stripQuotesAndBom(env?.BAILIAN_API_KEY);
  if (envKey) {
    return {
      apiKey: envKey,
      dashScopeBase: DEFAULT_DASHSCOPE_BASE,
      openAiBase: DEFAULT_OPENAI_BASE,
      workspaceId: '',
    };
  }

  const resolvedConfigDir =
    configDir === undefined ? path.join(os.homedir(), '.gemini', 'config') : configDir;

  if (resolvedConfigDir) {
    for (const filename of ['bailian-api-key.csv', 'bailian-api-key.txt']) {
      const creds = tryReadCredentialFile(path.join(resolvedConfigDir, filename));
      if (creds) return creds;
    }
  }

  const resolvedProjectDir =
    projectDir === undefined ? path.resolve(import.meta.dirname, '..') : projectDir;

  if (resolvedProjectDir) {
    try {
      const entries = fs
        .readdirSync(resolvedProjectDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /apiKey/i.test(entry.name) && /\.csv$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      for (const name of entries) {
        const creds = tryReadCredentialFile(path.join(resolvedProjectDir, name));
        if (creds) return creds;
      }
    } catch {
      // Directory missing or unreadable; fall through to explicit exitCode=2 error.
    }
  }

  throw createCodedError(
    `Missing Bailian API key. Pass --key, set DASHSCOPE_API_KEY/BAILIAN_API_KEY, or place bailian-api-key.csv in ${resolvedConfigDir || 'config dir'} or *apiKey*.csv in project root.`,
    2
  );
}

function hasHeaderIgnoreCase(headers, targetLower) {
  return Object.keys(headers).some((k) => k.toLowerCase() === targetLower);
}

function getTransportForUrl(urlObj, rejectUnauthorized = true) {
  if (urlObj.protocol === 'https:') {
    return { transport: https, agent: DIRECT_HTTPS_AGENT, extraOpts: { rejectUnauthorized } };
  }
  if (urlObj.protocol === 'http:') {
    return { transport: http, agent: DIRECT_HTTP_AGENT, extraOpts: {} };
  }
  throw createCodedError(`Unsupported URL protocol: ${urlObj.protocol}`, 2);
}

function normalizeRequestBody(body, headers) {
  if (body === null || body === undefined) {
    return { bodyBuffer: null, bodyStream: null, headers };
  }
  if (typeof body.pipe === 'function') {
    return { bodyBuffer: null, bodyStream: body, headers };
  }
  const bodyBuffer =
    typeof body === 'string'
      ? Buffer.from(body, 'utf8')
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
  const nextHeaders = { ...headers };
  if (!hasHeaderIgnoreCase(nextHeaders, 'content-length')) {
    nextHeaders['Content-Length'] = String(bodyBuffer.length);
  }
  return { bodyBuffer, bodyStream: null, headers: nextHeaders };
}

/**
 * Perform a direct HTTP/HTTPS request bypassing environment proxy settings.
 */
export function directHttpsRequest(
  urlString,
  {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 60_000,
    rejectUnauthorized = true,
    secrets = [],
  } = {}
) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch (err) {
    return Promise.reject(createCodedError(`Invalid URL: ${err.message}`, 2, secrets));
  }

  let transportInfo;
  try {
    transportInfo = getTransportForUrl(urlObj, rejectUnauthorized);
  } catch (err) {
    return Promise.reject(err);
  }

  const { bodyBuffer, bodyStream, headers: finalHeaders } = normalizeRequestBody(body, headers);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (bodyStream && typeof bodyStream.destroy === 'function') {
        bodyStream.destroy();
      }
      reject(err);
    };

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || undefined,
      path: `${urlObj.pathname}${urlObj.search}`,
      method,
      headers: finalHeaders,
      agent: transportInfo.agent,
      ...transportInfo.extraOpts,
    };

    req = transportInfo.transport.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => {
        finishReject(createCodedError(`HTTP response aborted for ${urlObj.hostname}`, 3, secrets));
      });
      res.on('error', (err) => {
        finishReject(
          createCodedError(`HTTP response error: ${err.message}`, 3, secrets, { code: err.code })
        );
      });
      res.on('close', () => {
        if (!settled && !res.complete) {
          finishReject(
            createCodedError(`HTTP response closed prematurely for ${urlObj.hostname}`, 3, secrets, {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            })
          );
        }
      });
      res.on('end', () => {
        if (!res.complete) {
          finishReject(createCodedError(`Incomplete HTTP response from ${urlObj.hostname}`, 3, secrets));
          return;
        }
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const resBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          bodyBuffer: resBuffer,
          text() {
            return resBuffer.toString('utf8');
          },
          json() {
            return JSON.parse(resBuffer.toString('utf8'));
          },
        });
      });
    });

    timer = setTimeout(() => {
      const timeoutErr = createCodedError(
        `Request timed out after ${timeoutMs}ms (${urlObj.hostname})`,
        4,
        secrets,
        { code: 'ETIMEDOUT', isTimeout: true }
      );
      req.destroy(timeoutErr);
      finishReject(timeoutErr);
    }, timeoutMs);

    req.on('error', (err) => {
      if (err?.isTimeout || err?.exitCode === 4) {
        finishReject(err);
        return;
      }
      finishReject(
        createCodedError(`Direct request error (${urlObj.hostname}): ${err.message}`, 3, secrets, {
          code: err.code,
        })
      );
    });

    if (bodyStream) {
      bodyStream.on('error', (err) => {
        const streamErr = createCodedError(`Request stream error: ${err.message}`, 3, secrets, {
          code: err.code,
        });
        req.destroy(streamErr);
        finishReject(streamErr);
      });
      bodyStream.pipe(req);
    } else if (bodyBuffer !== null) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

function detectMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}

function formatMultipartField(boundary, name, value) {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  );
}

function remainingTimeoutMs(deadline, label, secrets) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw createCodedError(`${label} timed out`, 4, secrets, { code: 'ETIMEDOUT', isTimeout: true });
  }
  return remaining;
}

function streamMultipartToOss(uploadUrl, { boundary, preambleBuf, epilogueBuf, filePath, contentLength, timeoutMs, secrets }) {
  let urlObj;
  try {
    urlObj = new URL(/^https?:\/\//i.test(uploadUrl) ? uploadUrl : `https://${uploadUrl}`);
  } catch (err) {
    return Promise.reject(createCodedError(`Invalid OSS upload_host: ${err.message}`, 3, secrets));
  }

  const transportInfo = getTransportForUrl(urlObj, true);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const readStream = fs.createReadStream(filePath);

    const cleanupStream = () => {
      if (!readStream.destroyed) {
        readStream.destroy();
      }
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupStream();
      reject(err);
    };

    const req = transportInfo.transport.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || undefined,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(contentLength),
        },
        agent: transportInfo.agent,
        ...transportInfo.extraOpts,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('aborted', () => {
          finishReject(createCodedError('OSS upload response aborted', 3, secrets));
        });
        res.on('error', (err) => {
          finishReject(createCodedError(`OSS response error: ${err.message}`, 3, secrets));
        });
        res.on('close', () => {
          if (!settled && !res.complete) {
            finishReject(
              createCodedError('OSS upload response closed prematurely', 3, secrets, {
                code: 'ERR_STREAM_PREMATURE_CLOSE',
              })
            );
          }
        });
        res.on('end', () => {
          if (!res.complete) {
            finishReject(createCodedError('OSS upload response incomplete', 3, secrets));
            return;
          }
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          cleanupStream();
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode ?? 0, bodyText });
        });
      }
    );

    timer = setTimeout(() => {
      const timeoutErr = createCodedError(`OSS upload timed out after ${timeoutMs}ms`, 4, secrets, {
        code: 'ETIMEDOUT',
        isTimeout: true,
      });
      req.destroy(timeoutErr);
      finishReject(timeoutErr);
    }, timeoutMs);

    req.on('error', (err) => {
      if (err?.isTimeout || err?.exitCode === 4) {
        finishReject(err);
        return;
      }
      finishReject(
        createCodedError(`OSS upload socket error: ${err.message}`, 3, secrets, { code: err.code })
      );
    });

    readStream.on('error', (err) => {
      const fileErr = createCodedError(`Failed reading upload file: ${err.message}`, 3, secrets, {
        code: err.code,
      });
      req.destroy(fileErr);
      finishReject(fileErr);
    });

    req.write(preambleBuf);
    readStream.pipe(req, { end: false });
    readStream.on('end', () => {
      if (!settled && !req.destroyed) {
        req.end(epilogueBuf);
      }
    });
  });
}

/**
 * Upload a local media file to Bailian temporary OSS storage via getPolicy + PostObject.
 */
export async function uploadToBailianOss(
  filePath,
  { creds, model = 'qwen3.8-omni-flash', timeoutMs = 180_000 } = {}
) {
  const secrets = [creds?.apiKey];
  if (!creds?.apiKey) {
    throw createCodedError('Missing API key for Bailian OSS upload', 2, secrets);
  }
  if (!filePath || !model) {
    throw createCodedError('Missing filePath or model for Bailian OSS upload', 2, secrets);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw createCodedError(`Cannot stat upload file ${filePath}: ${err.message}`, 2, secrets);
  }
  if (!stat.isFile()) {
    throw createCodedError(`Upload path is not a file: ${filePath}`, 2, secrets);
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const dashScopeBase = stripTrailingSlashes(creds.dashScopeBase || DEFAULT_DASHSCOPE_BASE);
  const policyUrl = `${dashScopeBase}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;

  const policyRes = await directHttpsRequest(policyUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: 'application/json',
    },
    timeoutMs: remainingTimeoutMs(deadline, 'Bailian getPolicy', secrets),
    secrets,
  });

  if (policyRes.statusCode < 200 || policyRes.statusCode >= 300) {
    throw createCodedError(
      `Bailian getPolicy failed (HTTP ${policyRes.statusCode}): ${policyRes.text().slice(0, 500)}`,
      3,
      secrets,
      { statusCode: policyRes.statusCode }
    );
  }

  let policyJson;
  try {
    policyJson = policyRes.json();
  } catch (err) {
    throw createCodedError(`Invalid JSON from Bailian getPolicy: ${err.message}`, 3, secrets);
  }

  const policy = policyJson?.data ?? policyJson;
  const requiredFields = ['upload_host', 'upload_dir', 'oss_access_key_id', 'policy', 'signature'];
  for (const field of requiredFields) {
    if (!policy?.[field]) {
      throw createCodedError(`Bailian getPolicy response missing ${field}`, 3, secrets);
    }
  }

  const boundary = `----biliOmniBoundary${crypto.randomUUID().replace(/-/g, '')}`;
  const rawBaseName = path.basename(filePath);
  const safeFileName = rawBaseName.replace(/["\\\r\n]/g, '_') || 'media.mp4';
  const uploadDir = String(policy.upload_dir).replace(/^\/+|\/+$/g, '');
  const objectKey = uploadDir ? `${uploadDir}/${safeFileName}` : safeFileName;

  const formFields = [
    ['OSSAccessKeyId', policy.oss_access_key_id],
    ['policy', policy.policy],
    ['Signature', policy.signature],
    ['key', objectKey],
  ];
  if (policy.x_oss_object_acl !== undefined && policy.x_oss_object_acl !== null) {
    formFields.push(['x-oss-object-acl', String(policy.x_oss_object_acl)]);
  }
  if (policy.x_oss_forbid_overwrite !== undefined && policy.x_oss_forbid_overwrite !== null) {
    formFields.push(['x-oss-forbid-overwrite', String(policy.x_oss_forbid_overwrite)]);
  }
  formFields.push(['success_action_status', '200']);

  // OSS PostObject requires the `file` field to be the final multipart field.
  const preamble =
    formFields.map(([name, val]) => formatMultipartField(boundary, name, val)).join('') +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
    `Content-Type: ${detectMimeType(safeFileName)}\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--\r\n`;

  const preambleBuf = Buffer.from(preamble, 'utf8');
  const epilogueBuf = Buffer.from(epilogue, 'utf8');
  const contentLength = preambleBuf.length + stat.size + epilogueBuf.length;

  const uploadRes = await streamMultipartToOss(policy.upload_host, {
    boundary,
    preambleBuf,
    epilogueBuf,
    filePath,
    contentLength,
    timeoutMs: remainingTimeoutMs(deadline, 'Bailian OSS upload', secrets),
    secrets,
  });

  if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) {
    throw createCodedError(
      `Bailian OSS upload failed (HTTP ${uploadRes.statusCode}): ${uploadRes.bodyText.slice(0, 500)}`,
      3,
      secrets,
      { statusCode: uploadRes.statusCode }
    );
  }

  return {
    ossUri: `oss://${objectKey}`,
    uploadMs: Date.now() - startedAt,
    sizeBytes: stat.size,
  };
}

/**
 * Create a mutable state object for incremental SSE stream parsing.
 */
export function createSseParser() {
  return {
    buffer: '',
    pendingDataLines: [],
    content: '',
    reasoningContent: '',
    usage: null,
    done: false,
    eventsCount: 0,
    finishReason: null,
    error: null,
  };
}

function extractDeltaText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

function applyParsedSseEvent(state, parsed, contentDeltas, reasoningDeltas, events) {
  state.eventsCount += 1;
  events.push(parsed);

  if (parsed?.error) {
    state.error = parsed.error;
  }
  if (parsed?.usage) {
    state.usage = parsed.usage;
  }
  if (!Array.isArray(parsed?.choices)) {
    return;
  }

  for (const choice of parsed.choices) {
    const delta = choice?.delta || choice?.message || {};
    const reasoning = extractDeltaText(delta.reasoning_content ?? delta.reasoning);
    if (reasoning.length > 0) {
      state.reasoningContent += reasoning;
      reasoningDeltas.push(reasoning);
    }
    const content = extractDeltaText(delta.content);
    if (content.length > 0) {
      state.content += content;
      contentDeltas.push(content);
    }
    if (choice?.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
  }
}

/**
 * Feed a text or Buffer SSE chunk into parser state and return newly emitted deltas.
 */
export function feedSseChunk(state, chunkStr) {
  const chunkText = typeof chunkStr === 'string' ? chunkStr : Buffer.from(chunkStr || '').toString('utf8');
  const contentDeltas = [];
  const reasoningDeltas = [];
  const events = [];

  if (chunkText.length > 0) {
    state.buffer += chunkText;
  }

  let newlineIdx;
  while ((newlineIdx = state.buffer.indexOf('\n')) !== -1) {
    const rawLine = state.buffer.slice(0, newlineIdx).replace(/\r$/, '');
    state.buffer = state.buffer.slice(newlineIdx + 1);

    if (rawLine === '') {
      if (state.pendingDataLines.length > 0) {
        const joined = state.pendingDataLines.join('\n').trim();
        state.pendingDataLines = [];
        if (joined === '[DONE]') {
          state.done = true;
        } else if (joined) {
          try {
            applyParsedSseEvent(state, JSON.parse(joined), contentDeltas, reasoningDeltas, events);
          } catch {
            // Ignore malformed trailing fragments on event boundary.
          }
        }
      }
      continue;
    }

    if (rawLine.startsWith(':') || !rawLine.startsWith('data:')) {
      continue;
    }

    const payload = rawLine.startsWith('data: ') ? rawLine.slice(6) : rawLine.slice(5);
    if (payload.trim() === '[DONE]') {
      state.pendingDataLines = [];
      state.done = true;
      continue;
    }

    const candidate =
      state.pendingDataLines.length > 0 ? `${state.pendingDataLines.join('\n')}\n${payload}` : payload;

    try {
      const parsed = JSON.parse(candidate);
      state.pendingDataLines = [];
      applyParsedSseEvent(state, parsed, contentDeltas, reasoningDeltas, events);
    } catch {
      state.pendingDataLines.push(payload);
    }
  }

  return {
    contentDeltas,
    reasoningDeltas,
    contentDelta: contentDeltas.join(''),
    reasoningDelta: reasoningDeltas.join(''),
    events,
    done: state.done,
  };
}

function hasOssUriInMessages(messages) {
  try {
    return JSON.stringify(messages).includes('oss://');
  } catch {
    return false;
  }
}

function isOssExpiredError(statusCode, errorText, messages) {
  if (statusCode !== 400 && statusCode !== 404) return false;
  if (!hasOssUriInMessages(messages)) return false;
  const text = String(errorText || '');
  if (/\bmodel\b.*not\s*(found|exist)/i.test(text) && !/oss|nosuchkey|resource/i.test(text)) {
    return false;
  }
  return (
    /oss:\/\/|ossresource|nosuchkey|invalidparameter|invalid_parameter/i.test(text) ||
    /(oss|file|url|media|video|resource).*(expired|not\s*found|not\s*exist|does\s*not\s*exist|invalid|failed|access|denied|resolve|download)/i.test(
      text
    ) ||
    /(expired|not\s*found|does\s*not\s*exist).*(oss|file|url|media|video|resource)/i.test(text)
  );
}

function isTransientNetworkError(err) {
  if (!err || err.isTimeout || err.exitCode === 4) return false;
  if (TRANSIENT_ERROR_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return /socket hang up|ECONNRESET|EPIPE|ETIMEDOUT|premature|aborted/i.test(msg);
}

async function sleepBeforeRetry(delayMs, deadline, secrets) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw createCodedError('Bailian chat request timed out before retry', 4, secrets, {
      code: 'ETIMEDOUT',
      isTimeout: true,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
  if (Date.now() >= deadline) {
    throw createCodedError('Bailian chat request timed out during retry backoff', 4, secrets, {
      code: 'ETIMEDOUT',
      isTimeout: true,
    });
  }
}

function streamChatAttempt(
  endpointUrl,
  { requestBody, apiKey, timeoutMs, startedAt, onContentDelta, messages, secrets }
) {
  let urlObj;
  try {
    urlObj = new URL(endpointUrl);
  } catch (err) {
    return Promise.reject(createCodedError(`Invalid openAiBase URL: ${err.message}`, 2, secrets));
  }

  const transportInfo = getTransportForUrl(urlObj, true);
  const bodyBuf = Buffer.from(requestBody, 'utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let hasEmittedDelta = false;
    let ttftMs = null;

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      err.hasEmittedDelta = hasEmittedDelta;
      reject(err);
    };

    const req = transportInfo.transport.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || undefined,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          'Content-Length': String(bodyBuf.length),
          'X-DashScope-OssResourceResolve': 'enable',
        },
        agent: transportInfo.agent,
        ...transportInfo.extraOpts,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (statusCode < 200 || statusCode >= 300) {
          const errChunks = [];
          res.on('data', (chunk) => errChunks.push(chunk));
          res.on('error', (err) => {
            finishReject(
              createCodedError(`Bailian error stream failed: ${err.message}`, 3, secrets, {
                statusCode,
                code: err.code,
              })
            );
          });
          res.on('end', () => {
            const rawText = Buffer.concat(errChunks).toString('utf8');
            const ossExpired = isOssExpiredError(statusCode, rawText, messages);
            finishReject(
              createCodedError(
                `Bailian API error (HTTP ${statusCode}): ${rawText.slice(0, 800)}`,
                3,
                secrets,
                { statusCode, ossExpired }
              )
            );
          });
          return;
        }

        const parser = createSseParser();
        const decoder = new StringDecoder('utf8');

        const handleFeedResult = (parsedResult) => {
          if (ttftMs === null && (parsedResult.contentDelta.length > 0 || parsedResult.reasoningDelta.length > 0)) {
            ttftMs = Date.now() - startedAt;
          }
          if (parsedResult.contentDelta.length > 0 || parsedResult.reasoningDelta.length > 0) {
            hasEmittedDelta = true;
          }
          if (typeof onContentDelta === 'function') {
            for (const delta of parsedResult.contentDeltas) {
              onContentDelta(delta);
            }
          }
          if (parser.error) {
            const errText =
              typeof parser.error === 'string' ? parser.error : JSON.stringify(parser.error);
            const ossExpired = isOssExpiredError(400, errText, messages);
            const streamErr = createCodedError(`Bailian SSE error: ${errText}`, 3, secrets, {
              statusCode: 400,
              ossExpired,
            });
            req.destroy(streamErr);
            finishReject(streamErr);
          }
        };

        res.on('data', (chunk) => {
          if (settled) return;
          const text = decoder.write(chunk);
          if (text) {
            handleFeedResult(feedSseChunk(parser, text));
          }
        });

        res.on('aborted', () => {
          finishReject(createCodedError('Bailian SSE stream aborted', 3, secrets));
        });

        res.on('error', (err) => {
          finishReject(
            createCodedError(`Bailian SSE stream error: ${err.message}`, 3, secrets, {
              code: err.code,
            })
          );
        });

        res.on('close', () => {
          if (!settled && !res.complete) {
            finishReject(
              createCodedError('Bailian SSE stream closed prematurely', 3, secrets, {
                code: 'ERR_STREAM_PREMATURE_CLOSE',
              })
            );
          }
        });

        res.on('end', () => {
          if (settled) return;
          if (!res.complete) {
            finishReject(createCodedError('Bailian SSE stream ended prematurely', 3, secrets));
            return;
          }
          const trailing = decoder.end();
          if (trailing) {
            handleFeedResult(feedSseChunk(parser, trailing));
            if (settled) return;
          }
          if (parser.buffer.length > 0 || parser.pendingDataLines.length > 0) {
            handleFeedResult(feedSseChunk(parser, '\n\n'));
            if (settled) return;
          }

          settled = true;
          if (timer) clearTimeout(timer);
          const inferenceMs = Date.now() - startedAt;
          resolve({
            content: parser.content,
            reasoningContent: parser.reasoningContent,
            usage: parser.usage,
            ttftMs: ttftMs ?? inferenceMs,
            inferenceMs,
          });
        });
      }
    );

    timer = setTimeout(() => {
      const timeoutErr = createCodedError(
        `Bailian chat request timed out after ${timeoutMs}ms`,
        4,
        secrets,
        { code: 'ETIMEDOUT', isTimeout: true }
      );
      req.destroy(timeoutErr);
      finishReject(timeoutErr);
    }, timeoutMs);

    req.on('error', (err) => {
      if (err?.isTimeout || err?.exitCode === 4) {
        finishReject(err);
        return;
      }
      finishReject(
        createCodedError(`Bailian request error: ${err.message}`, 3, secrets, {
          code: err.code,
        })
      );
    });

    req.end(bodyBuf);
  });
}

/**
 * Call Bailian OpenAI-compatible chat completions over direct HTTPS SSE with retries.
 */
export async function chatWithBailian({
  creds,
  model = 'qwen3.8-omni-flash',
  messages,
  enableThinking = false,
  timeoutMs = 600_000,
  onContentDelta,
} = {}) {
  const secrets = [creds?.apiKey];
  if (!creds?.apiKey) {
    throw createCodedError('Missing API key for Bailian chat request', 2, secrets);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw createCodedError('messages must be a non-empty array', 2, secrets);
  }

  const openAiBase = stripTrailingSlashes(creds.openAiBase || DEFAULT_OPENAI_BASE);
  const endpointUrl = `${openAiBase}/chat/completions`;
  const requestBody = JSON.stringify({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    modalities: ['text'],
    enable_thinking: Boolean(enableThinking),
  });

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const remaining = remainingTimeoutMs(deadline, 'Bailian chat', secrets);
      return await streamChatAttempt(endpointUrl, {
        requestBody,
        apiKey: creds.apiKey,
        timeoutMs: remaining,
        startedAt,
        onContentDelta,
        messages,
        secrets,
      });
    } catch (err) {
      if (err?.isTimeout || err?.exitCode === 4) {
        throw err;
      }
      const canRetry =
        attempt < RETRY_DELAYS_MS.length &&
        !err?.hasEmittedDelta &&
        (RETRYABLE_STATUS_CODES.has(err?.statusCode) || isTransientNetworkError(err));

      if (!canRetry) {
        throw err;
      }

      await sleepBeforeRetry(RETRY_DELAYS_MS[attempt], deadline, secrets);
    }
  }

  throw createCodedError('Bailian chat request exhausted retries', 3, secrets);
}
