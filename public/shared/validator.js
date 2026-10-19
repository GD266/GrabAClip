/**
 * Shared YouTube URL validation utilities
 * Used by both frontend and backend (duplicated logic for Isomorphic use)
 */

// Allowed hosts for YouTube
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

/**
 * Extract video ID from various YouTube URL formats
 * Returns videoId string or null if not found
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

      // youtu.be style sometimes via youtube.com?
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

export function isValidVideoId(id) {
  // YouTube video IDs are 11 chars, alphanumeric + - _
  // But be permissive: allow 11 chars strictly
  return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export function isYouTubeUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  const trimmed = urlString.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();

    // Must be http or https
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    // Check host is allowed
    // Allow youtube.com and subdomains check
    const isAllowedHost =
      YOUTUBE_HOSTS.has(host) ||
      host.endsWith(".youtube.com") ||
      host.endsWith(".youtube-nocookie.com");

    if (!isAllowedHost) return false;

    // Must contain a valid video ID
    const vid = extractVideoId(trimmed);
    return vid !== null;
  } catch {
    return false;
  }
}

/**
 * Normalize YouTube URL to canonical form
 */
export function normalizeYouTubeUrl(urlString) {
  const vid = extractVideoId(urlString);
  if (!vid) return null;
  return `https://www.youtube.com/watch?v=${vid}`;
}
