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

  // formatId is optional, but if provided must be valid
  // quality alternative: if neither provided, use best
  const formatId = query.formatId || query.format_id || query.quality || null;

  // If formatId looks like a height (144,240,360,480,720,1080,1440,2160) allow it
  // Only whitelist known heights to avoid colliding with numeric formatIds like 137
  if (formatId) {
    const str = String(formatId).trim();
    if (/^(144|240|360|480|720|1080|1440|2160)p?$/.test(str)) {
      // normalize: 720p -> 720
      return {
        valid: true,
        videoId: extractVideoId(url),
        normalizedUrl: normalizeYouTubeUrl(url),
        formatId: str.replace("p", ""),
        isHeight: true,
      };
    }
    if (!isValidFormatId(str)) {
      return { valid: false, error: "Invalid format selection." };
    }
    return {
      valid: true,
      videoId: extractVideoId(url),
      normalizedUrl: normalizeYouTubeUrl(url),
      formatId: str,
      isHeight: false,
    };
  }

  return {
    valid: true,
    videoId: extractVideoId(url),
    normalizedUrl: normalizeYouTubeUrl(url),
    formatId: null,
    isHeight: false,
  };
}
