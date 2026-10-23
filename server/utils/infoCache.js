/**
 * Short-lived cache for processed media info.
 *
 * A download click should not have to run yt-dlp extraction again: the
 * frontend has already fetched /api/info right before, so re-using that
 * result removes seconds of latency (and an extra platform request) from
 * every download.
 *
 * Concurrent requests for the same URL share one in-flight fetch.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes: format ids stay valid, URLs are re-extracted per job anyway
const MAX_ENTRIES = 200;

const entries = new Map(); // url -> { at, info }
const inflight = new Map(); // url -> Promise<info>

export const INFO_CACHE_TTL_MS = TTL_MS;

export function getCachedInfo(url) {
  const entry = entries.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    entries.delete(url);
    return null;
  }
  return entry.info;
}

export function setCachedInfo(url, info) {
  if (!url || !info) return null;
  entries.set(url, { at: Date.now(), info });
  if (entries.size > MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of entries) {
      if (now - value.at > TTL_MS) entries.delete(key);
    }
    while (entries.size > MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
  }
  return info;
}

/**
 * Get info for a URL, using the cache when possible.
 * `loader` is only called on a miss; concurrent callers share one promise.
 */
export function getVideoInfoCached(url, loader) {
  const cached = getCachedInfo(url);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(url);
  if (pending) return pending;

  const promise = Promise.resolve()
    .then(() => loader())
    .then((info) => {
      if (info) setCachedInfo(url, info);
      return info;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}

export function clearInfoCache() {
  entries.clear();
}

export function getInfoCacheSize() {
  return entries.size;
}
