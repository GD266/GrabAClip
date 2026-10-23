/**
 * In-memory download status tracker.
 * Keyed by a composite key (type:url) to allow video + audio for same URL.
 * Status phases: preparing | fetching | processing | downloading | complete | failed
 */

const active = new Map();

let idCounter = 0;

export function startDownload(type, url) {
  const key = `${type}:${url}`;
  const entry = {
    id: ++idCounter,
    type,
    url,
    phase: "preparing",
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    error: null,
    // 0-100 progress of the media fetch from the source platform (platform -> server).
    progress: 0,
    // Human readable detail for the current phase (shown in the UI).
    detail: null,
  };
  active.set(key, entry);
  return entry;
}

export function setPhase(type, url, phase, extra = {}) {
  const key = `${type}:${url}`;
  const entry = active.get(key);
  if (!entry) return null;
  entry.phase = phase;
  entry.lastUpdate = Date.now();
  if (extra.error !== undefined) entry.error = extra.error;
  return entry;
}

/**
 * Update progress (0-100) and/or detail text for an active download.
 * Called while yt-dlp pulls media from the source platform.
 */
export function setProgressDetail(type, url, progress, detail) {
  const key = `${type}:${url}`;
  const entry = active.get(key);
  if (!entry) return null;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    entry.progress = Math.max(0, Math.min(100, Math.round(progress)));
  }
  if (detail !== undefined && detail !== null) entry.detail = detail;
  entry.lastUpdate = Date.now();
  return entry;
}

export function completeDownload(type, url) {
  const key = `${type}:${url}`;
  const entry = active.get(key);
  if (!entry) return null;
  entry.phase = "complete";
  entry.lastUpdate = Date.now();
  return entry;
}

export function failDownload(type, url, errorMsg) {
  const key = `${type}:${url}`;
  const entry = active.get(key);
  if (!entry) return null;
  entry.phase = "failed";
  entry.error = errorMsg || "Download failed";
  entry.lastUpdate = Date.now();
  return entry;
}

export function getStatus(type, url) {
  const key = `${type}:${url}`;
  return active.get(key) || null;
}

export function removeDownload(type, url) {
  const key = `${type}:${url}`;
  active.delete(key);
}

/**
 * Check if a download is already in progress (any active phase).
 */
export function isActive(type, url) {
  const key = `${type}:${url}`;
  const entry = active.get(key);
  if (!entry) return false;
  return entry.phase !== "complete" && entry.phase !== "failed";
}

/**
 * Get all active downloads (for debugging/health).
 */
export function getActiveDownloads() {
  return Array.from(active.values());
}

/**
 * Cleanup stale entries older than maxAgeMs.
 */
export function cleanupStale(maxAgeMs = 600000) {
  const now = Date.now();
  for (const [key, entry] of active) {
    if (entry.phase === "complete" || entry.phase === "failed") {
      if (now - entry.lastUpdate > maxAgeMs) {
        active.delete(key);
      }
    }
  }
}

// Auto-cleanup every 5 minutes
setInterval(() => cleanupStale(), 300000).unref();
