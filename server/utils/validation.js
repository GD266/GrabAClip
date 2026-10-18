import { isYouTubeUrl, extractVideoId, normalizeYouTubeUrl } from "../../shared/validator.js";

export { isYouTubeUrl, extractVideoId, normalizeYouTubeUrl };

/**
 * Validate formatId - alphanumeric, dash, underscore
 */
export function isValidFormatId(formatId) {
  return typeof formatId === "string" && /^[a-zA-Z0-9_-]{1,20}$/.test(formatId);
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

/**
 * Validate download request
 */
export function validateInfoRequest(body) {
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return { valid: false, error: "YouTube URL is required." };
  }
  if (!isYouTubeUrl(body.url)) {
    return {
      valid: false,
      error:
        "Invalid YouTube URL. Please provide a valid YouTube video URL (youtube.com/watch?v=... or youtu.be/...).",
    };
  }
  return { valid: true, videoId: extractVideoId(body.url), normalizedUrl: normalizeYouTubeUrl(body.url) };
}

const SELECTABLE_HEIGHTS = new Set([144, 240, 360, 480, 720, 1080]);
const HEIGHT_PATTERN = /^(144|240|360|480|720|1080)p?$/i;

export function validateDownloadQuery(query) {
  const url = query.url;
  if (!url || typeof url !== "string" || !url.trim()) {
    return { valid: false, error: "YouTube URL is required." };
  }
  if (!isYouTubeUrl(url)) {
    return {
      valid: false,
      error: "Invalid YouTube URL.",
    };
  }

  // Preferred selection: `height` (144p … 1080p), matching the quality list
  // built by buildVideoFormats().
  let height = null;
  const heightParam = query.height ?? query.quality;
  if (heightParam !== undefined && heightParam !== null && String(heightParam).trim() !== "") {
    const str = String(heightParam).trim();
    if (!HEIGHT_PATTERN.test(str)) {
      return { valid: false, error: "Invalid quality selection." };
    }
    height = parseInt(str, 10);
    if (!SELECTABLE_HEIGHTS.has(height)) {
      return { valid: false, error: "Invalid quality selection." };
    }
  }

  // Legacy: `formatId` with a raw yt-dlp format id, or a height like "720p".
  let formatId = null;
  const formatIdParam = query.formatId || query.format_id;
  if (!height && formatIdParam !== undefined && formatIdParam !== null && String(formatIdParam).trim() !== "") {
    const str = String(formatIdParam).trim();
    if (HEIGHT_PATTERN.test(str)) {
      height = parseInt(str, 10);
    } else if (isValidFormatId(str)) {
      formatId = str;
    } else {
      return { valid: false, error: "Invalid format selection." };
    }
  }

  return {
    valid: true,
    videoId: extractVideoId(url),
    normalizedUrl: normalizeYouTubeUrl(url),
    height,
    formatId,
  };
}
