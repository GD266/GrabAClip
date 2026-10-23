// The validator lives in public/ so the same file is served to the browser
// both by Express locally and by static hosts such as Vercel.
import {
  isYouTubeUrl,
  extractVideoId,
  normalizeYouTubeUrl,
  detectPlatform,
  isSupportedMediaUrl,
  normalizeMediaUrl,
  extractMediaId,
} from "../../public/shared/validator.js";

export {
  isYouTubeUrl,
  extractVideoId,
  normalizeYouTubeUrl,
  detectPlatform,
  isSupportedMediaUrl,
  normalizeMediaUrl,
  extractMediaId,
};

/**
 * Validate formatId - alphanumeric, dash, underscore. Generic sites use
 * longer ids (for example Instagram's dash-<id>v), so allow up to 64 chars.
 */
export function isValidFormatId(formatId) {
  return typeof formatId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(formatId);
}

/**
 * Sanitize filename for Content-Disposition
 * Removes path traversal, illegal chars, limits length
 */
export function sanitizeFilename(title) {
  if (!title || typeof title !== "string") return "video";

  // Remove path traversal attempts
  let name = title.replace(/[\/\\]/g, "_");

  // Remove control chars and illegal filename chars: < > : " | ? * and null
  // Also remove CR/LF explicitly to prevent header injection
  name = name.replace(/[\x00-\x1f\x7f<>:"|?*\r\n]/g, "");

  // Trim, collapse spaces
  name = name.trim().replace(/\s+/g, " ");

  // Remove leading dots (hidden files)
  name = name.replace(/^\.+/, "");

  // Limit length (100 chars + leave room for .mp4)
  if (name.length > 100) {
    name = name.slice(0, 100).trim();
  }

  // Fallback if empty after sanitization
  if (!name) return "video";

  // Remove trailing dots/spaces (Windows)
  name = name.replace(/[. ]+$/, "");

  if (!name) return "video";

  return name;
}

/**
 * Create a safe ASCII fallback for the quoted filename part of Content-Disposition.
 * Node's header validation rejects non-Latin1 / control chars.
 */
export function sanitizeAsciiFilename(name) {
  if (!name) return "video";
  // Keep only printable ASCII 0x20-0x7E, replace others with _
  // Also strip characters that break quoted-string: " ; \ and control
  let ascii = name.replace(/[^\x20-\x7E]/g, "_");
  ascii = ascii.replace(/[";\\]/g, "_");
  ascii = ascii.replace(/[\r\n]/g, "_");
  ascii = ascii.trim().replace(/\s+/g, " ");
  if (!ascii) return "video";
  // Ensure not empty after stripping and limit
  if (ascii.length > 80) ascii = ascii.slice(0, 80).trim();
  return ascii;
}

const SUPPORTED_LINKS =
  "Paste a YouTube, X, or Instagram video link (for example youtube.com/watch?v=…, x.com/user/status/…, or instagram.com/reel/…).";

/**
 * Validate info request for any supported platform.
 */
export function validateInfoRequest(body) {
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return { valid: false, error: `A video link is required. ${SUPPORTED_LINKS}` };
  }
  if (!isSupportedMediaUrl(body.url)) {
    return { valid: false, error: `Unsupported link. ${SUPPORTED_LINKS}` };
  }
  const platform = detectPlatform(body.url);
  const mediaId = extractMediaId(body.url);
  const normalizedUrl = normalizeMediaUrl(body.url);
  return { valid: true, platform, videoId: mediaId, mediaId, normalizedUrl };
}

// Generic sites expose arbitrary source resolutions (for example 270p on X
// or 504p on a portrait Instagram reel). The plan returned by /api/info is
// the source of truth; this only bounds the value to a safe, useful range.
const HEIGHT_PATTERN = /^\d{3,4}p?$/i;
const MIN_HEIGHT = 144;
const MAX_HEIGHT = 1080;

export function validateDownloadQuery(query) {
  const url = query.url;
  if (!url || typeof url !== "string" || !url.trim()) {
    return { valid: false, error: `A video link is required. ${SUPPORTED_LINKS}` };
  }
  if (!isSupportedMediaUrl(url)) {
    return { valid: false, error: `Unsupported link. ${SUPPORTED_LINKS}` };
  }

  // Preferred selection: `height` (the plan key returned by /api/info).
  let height = null;
  const heightParam = query.height ?? query.quality;
  if (heightParam !== undefined && heightParam !== null && String(heightParam).trim() !== "") {
    const str = String(heightParam).trim();
    if (!HEIGHT_PATTERN.test(str)) {
      return { valid: false, error: "Invalid quality selection." };
    }
    height = parseInt(str, 10);
    if (height < MIN_HEIGHT || height > MAX_HEIGHT) {
      return { valid: false, error: "Invalid quality selection." };
    }
  }

  // Legacy: `formatId` with a raw yt-dlp format id, or a height like "720p".
  let formatId = null;
  const formatIdParam = query.formatId || query.format_id;
  if (!height && formatIdParam !== undefined && formatIdParam !== null && String(formatIdParam).trim() !== "") {
    const str = String(formatIdParam).trim();
    if (HEIGHT_PATTERN.test(str)) {
      const parsed = parseInt(str, 10);
      if (parsed >= MIN_HEIGHT && parsed <= MAX_HEIGHT) height = parsed;
      else if (isValidFormatId(str)) formatId = str;
      else return { valid: false, error: "Invalid quality selection." };
    } else if (isValidFormatId(str)) {
      formatId = str;
    } else {
      return { valid: false, error: "Invalid format selection." };
    }
  }

  const platform = detectPlatform(url);
  const mediaId = extractMediaId(url);
  return {
    valid: true,
    platform,
    videoId: mediaId,
    mediaId,
    normalizedUrl: normalizeMediaUrl(url),
    height,
    formatId,
  };
}
