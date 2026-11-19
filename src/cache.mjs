import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TTL_MS = 42 * 3600 * 1000;
export const DEFAULT_CACHE_FILE = path.join(os.homedir(), '.cache', 'bili-omni', 'index.json');

/**
 * Build the 4-part Bailian OSS cache key.
 * Must include `model` because Bailian temporary `oss://` URIs are bound to the target model.
 */
export function buildCacheKey({ bvid, cid, quality, model }) {
  if (
    !bvid ||
    cid === undefined ||
    cid === null ||
    cid === '' ||
    quality === undefined ||
    quality === null ||
    quality === '' ||
    !model
  ) {
    throw new Error('Invalid cache key parameters: bvid, cid, quality, and model are required.');
  }
  return `${bvid}:${cid}:q${quality}:${model}`;
}

function resolveCacheFile(cacheFile) {
  return cacheFile || DEFAULT_CACHE_FILE;
}

function readIndexSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, entries: {} };
    }
    const entries =
      parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
        ? parsed.entries
        : {};
    return { exists: true, entries };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, entries: {} };
    }
    return { exists: true, entries: {} };
  }
}

function pruneExpiredEntries(entries, now) {
  const next = {};
  let pruned = false;
  for (const [key, entry] of Object.entries(entries)) {
    const valid =
      entry &&
      typeof entry === 'object' &&
      typeof entry.ossUri === 'string' &&
      entry.ossUri.length > 0 &&
      typeof entry.expiresAt === 'number' &&
      Number.isFinite(entry.expiresAt) &&
      entry.expiresAt > now;
    if (valid) {
      next[key] = entry;
    } else {
      pruned = true;
    }
  }
  return { entries: next, pruned };
}

function writeIndexAtomic(filePath, entries) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const payload = JSON.stringify({ version: 1, entries }, null, 2);
  try {
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup failure after write error.
    }
    throw err;
  }
}

/**
 * Look up a cached `oss://` entry, pruning any expired entries from the index.
 */
export function getCachedOss(keyParams, { cacheFile, now = Date.now() } = {}) {
  const targetFile = resolveCacheFile(cacheFile);
  const { exists, entries } = readIndexSafe(targetFile);
  if (!exists) return null;

  const key = buildCacheKey(keyParams);
  const { entries: active, pruned } = pruneExpiredEntries(entries, now);
  if (pruned) {
    try {
      writeIndexAtomic(targetFile, active);
    } catch {
      // Do not fail a read lookup if pruning persistence hits a transient FS issue.
    }
  }

  const entry = active[key];
  if (!entry) return null;
  return {
    ossUri: entry.ossUri,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    bvid: entry.bvid,
    cid: entry.cid,
    quality: entry.quality,
    model: entry.model,
  };
}

/**
 * Persist an `oss://` URI entry atomically with TTL expiration.
 */
export function setCachedOss(
  keyParams,
  ossUri,
  { cacheFile, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {},
) {
  if (typeof ossUri !== 'string' || !ossUri.trim()) {
    throw new Error('ossUri must be a non-empty string.');
  }
  const targetFile = resolveCacheFile(cacheFile);
  const key = buildCacheKey(keyParams);
  const { entries } = readIndexSafe(targetFile);
  const { entries: active } = pruneExpiredEntries(entries, now);

  const record = {
    ossUri: ossUri.trim(),
    createdAt: now,
    expiresAt: now + ttlMs,
    bvid: keyParams.bvid,
    cid: keyParams.cid,
    quality: keyParams.quality,
    model: keyParams.model,
  };
  active[key] = record;
  writeIndexAtomic(targetFile, active);
  return { ...record };
}

/**
 * Remove a cached `oss://` entry if present.
 */
export function deleteCachedOss(keyParams, { cacheFile } = {}) {
  const targetFile = resolveCacheFile(cacheFile);
  const { exists, entries } = readIndexSafe(targetFile);
  if (!exists) return false;

  const key = buildCacheKey(keyParams);
  if (!Object.prototype.hasOwnProperty.call(entries, key)) {
    return false;
  }
  delete entries[key];
  writeIndexAtomic(targetFile, entries);
  return true;
}
