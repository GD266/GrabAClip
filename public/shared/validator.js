/**
 * Shared media URL validation utilities.
 * Used by both frontend and backend (duplicated logic for isomorphic use).
 *
 * Supported platforms:
 *   - YouTube: watch, shorts, live, embed, youtu.be
 *   - X / Twitter: /<user>/status/<id>[/video/<n>]
 *   - Instagram: reel, p and tv posts
 */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
]);

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

const INSTAGRAM_KINDS = new Set(["reel", "reels", "p", "tv"]);

function parseHttpUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  const trimmed = urlString.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function isYouTubeHost(host) {
  return (
    YOUTUBE_HOSTS.has(host) ||
    host.endsWith(".youtube.com") ||
    host.endsWith(".youtube-nocookie.com")
  );
}

function isXHost(host) {
  return X_HOSTS.has(host);
}

function isInstagramHost(host) {
  return INSTAGRAM_HOSTS.has(host);
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/**
 * Extract video ID from various YouTube URL formats.
 * Returns videoId string or null if not found.
 */
export function extractVideoId(urlString) {
  try {
    const url = new URL(urlString.trim());

    const host = url.hostname.toLowerCase();

    // youtu.be/<id>
    if (host === "youtu.be" || host === "www.youtu.be") {
      const id = url.pathname.slice(1).split("/")[0].split("?")[0];
      if (isValidVideoId(id)) return id;
      return null;
    }

    // youtube.com hosts
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      // /watch?v=VIDEO_ID
      const v = url.searchParams.get("v");
      if (v && isValidVideoId(v)) return v;

      // /embed/VIDEO_ID , /v/VIDEO_ID , /shorts/VIDEO_ID , /live/VIDEO_ID
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 2) {
        const prefix = pathParts[0];
        if (["embed", "v", "shorts", "live"].includes(prefix)) {
          const id = pathParts[1];
          if (isValidVideoId(id)) return id;
        }
      }

      return null;
    }

    return null;
  } catch {
    return null;
  }
}

export function isValidVideoId(id) {
  // YouTube video IDs are 11 chars, alphanumeric + - _
  return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export function isYouTubeUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  const trimmed = urlString.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();

    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!isYouTubeHost(host)) return false;

    return extractVideoId(trimmed) !== null;
  } catch {
    return false;
  }
}

/**
 * Normalize YouTube URL to canonical form.
 */
export function normalizeYouTubeUrl(urlString) {
  const vid = extractVideoId(urlString);
  if (!vid) return null;
  return `https://www.youtube.com/watch?v=${vid}`;
}

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

function parseXStatus(urlString) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  if (!isXHost(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const statusIndex = parts.findIndex((part) => {
    const p = part.toLowerCase();
    return p === "status" || p === "statuses";
  });
  if (statusIndex < 0 || statusIndex + 1 >= parts.length) return null;

  const id = parts[statusIndex + 1];
  if (!/^\d{5,25}$/.test(id)) return null;

  // The only valid user-handle shape is /<handle>/status/<id>. Paths such as
  // /i/web/status/<id> intentionally have no handle.
  const before = parts.slice(0, statusIndex);
  let user = null;
  if (before.length === 1 && !["i", "web"].includes(before[0].toLowerCase())) {
    if (!/^[A-Za-z0-9_]{1,30}$/.test(before[0])) return null;
    user = before[0];
  } else if (before.length > 1) {
    const isIWeb = before.length === 2 &&
      before[0].toLowerCase() === "i" &&
      before[1].toLowerCase() === "web";
    if (!isIWeb) return null;
  }

  let videoIndex = 1;
  for (let i = statusIndex + 2; i < parts.length - 1; i += 1) {
    if (parts[i].toLowerCase() === "video" && /^\d+$/.test(parts[i + 1])) {
      videoIndex = Number(parts[i + 1]);
      break;
    }
  }

  return { user, id, videoIndex };
}

export function extractXStatusId(urlString) {
  return parseXStatus(urlString)?.id || null;
}

export function isXUrl(urlString) {
  return parseXStatus(urlString) !== null;
}

/**
 * Canonical X URL. A bare status URL is aimed at the first video so a tweet
 * with several attached videos does not become an unsupported playlist.
 */
export function normalizeXUrl(urlString) {
  const parsed = parseXStatus(urlString);
  if (!parsed) return null;
  const { user, id, videoIndex } = parsed;
  const base = user
    ? `https://x.com/${user}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
  return `${base}/video/${videoIndex || 1}`;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

function parseInstagramMedia(urlString) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  if (!isInstagramHost(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const kindIndex = parts.findIndex((part) => INSTAGRAM_KINDS.has(part.toLowerCase()));
  if (kindIndex < 0 || kindIndex + 1 >= parts.length) return null;

  // Accept /<username>/reel/<code> as well as the short /reel/<code> form,
  // but do not accept arbitrary profile or nested paths.
  if (kindIndex > 1) return null;

  let kind = parts[kindIndex].toLowerCase();
  const code = parts[kindIndex + 1];
  // Instagram media shortcodes are 8-30 URL-safe chars. A shorter segment is
  // usually a sub-page such as /reels/audio/<id>/.
  if (!/^[A-Za-z0-9_-]{8,30}$/.test(code)) return null;
  if (kind === "reels") kind = "reel";

  return { kind, code };
}

export function extractInstagramId(urlString) {
  return parseInstagramMedia(urlString)?.code || null;
}

export function isInstagramUrl(urlString) {
  return parseInstagramMedia(urlString) !== null;
}

export function normalizeInstagramUrl(urlString) {
  const parsed = parseInstagramMedia(urlString);
  if (!parsed) return null;
  return `https://www.instagram.com/${parsed.kind}/${parsed.code}/`;
}

// ---------------------------------------------------------------------------
// Universal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the supported platform for a URL.
 * Returns "youtube", "x", "instagram" or null.
 */
export function detectPlatform(urlString) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if (isYouTubeHost(host) && extractVideoId(urlString)) return "youtube";
  if (isXHost(host) && parseXStatus(urlString)) return "x";
  if (isInstagramHost(host) && parseInstagramMedia(urlString)) return "instagram";
  return null;
}

export function isSupportedMediaUrl(urlString) {
  return normalizeMediaUrl(urlString) !== null;
}

/**
 * Canonical URL used as the cache key, download-status key and job URL.
 */
export function normalizeMediaUrl(urlString) {
  const platform = detectPlatform(urlString);
  if (platform === "youtube") return normalizeYouTubeUrl(urlString);
  if (platform === "x") return normalizeXUrl(urlString);
  if (platform === "instagram") return normalizeInstagramUrl(urlString);
  return null;
}

/**
 * Stable media/status identifier for a supported URL. Used only as a fallback
 * when matching a download-status entry, never for security decisions.
 */
export function extractMediaId(urlString) {
  const platform = detectPlatform(urlString);
  if (platform === "youtube") return extractVideoId(urlString);
  if (platform === "x") return extractXStatusId(urlString);
  if (platform === "instagram") return extractInstagramId(urlString);
  return null;
}
