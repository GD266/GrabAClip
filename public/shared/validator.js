/**
 * Shared media URL validation utilities.
 * Used by both frontend and backend (duplicated logic for isomorphic use).
 *
 * Supported platforms:
 *   - YouTube: watch, shorts, live, embed, youtu.be
 *   - X / Twitter: /<user>/status/<id>[/video/<n>]
 *   - Instagram: reel, p and tv posts
 *   - Facebook: watch/video/reel URLs, public photo and post links, share links
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

const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "mobile.facebook.com",
  "web.facebook.com",
  "fb.watch",
  "www.fb.watch",
]);

const FACEBOOK_SHARE_KINDS = new Set(["v", "r", "p", "a"]);

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

function isFacebookHost(host) {
  return FACEBOOK_HOSTS.has(host);
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
// Facebook
// ---------------------------------------------------------------------------

function isFacebookMediaId(value) {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function isFacebookShareToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{5,64}$/.test(value);
}

function facebookVideoUrl(id) {
  return `https://www.facebook.com/watch/?v=${id}`;
}

/**
 * Parse the public Facebook URL shapes that can hold downloadable media.
 * Profile, feed, marketplace and group landing pages intentionally do not
 * match: they are not a single media item and often require a session.
 */
function parseFacebookUrl(urlString) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  if (!isFacebookHost(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());

  // fb.watch/<token> is Facebook's video short-link host. The final media URL
  // is resolved server-side because the token alone carries no media type.
  if (host === "fb.watch" || host === "www.fb.watch") {
    const token = parts[0];
    if (parts.length === 1 && isFacebookShareToken(token)) {
      return { kind: "short", id: token, canonical: `https://fb.watch/${token}/` };
    }
    return null;
  }

  // /share/v/<token>, /share/r/<token>, /share/p/<token>, /share/a/<token>
  if (lower[0] === "share") {
    const kind = lower[1];
    const token = parts[2];
    if (parts.length >= 3 && FACEBOOK_SHARE_KINDS.has(kind) && isFacebookShareToken(token)) {
      return { kind: "short", id: token, canonical: `https://www.facebook.com/share/${kind}/${token}/` };
    }
    return null;
  }

  // /watch/?v=<id>, /watch?v=<id>, /watch/<id>
  if (lower[0] === "watch") {
    const id = url.searchParams.get("v") || parts[1];
    if (isFacebookMediaId(id)) return { kind: "video", id, canonical: facebookVideoUrl(id) };
    return null;
  }

  // /video.php?v=<id>
  if (lower[0] === "video.php") {
    const id = url.searchParams.get("v");
    if (isFacebookMediaId(id)) return { kind: "video", id, canonical: facebookVideoUrl(id) };
    return null;
  }

  // /reel/<id>, /reels/<id>
  if (lower[0] === "reel" || lower[0] === "reels") {
    const id = parts[1];
    if (isFacebookMediaId(id)) {
      return { kind: "reel", id, canonical: `https://www.facebook.com/reel/${id}/` };
    }
    return null;
  }

  // /videos/<id> and /<user>/videos/<id> (the latter may include a slug).
  const videosIndex = lower.indexOf("videos");
  if (videosIndex >= 0) {
    const id = [...parts.slice(videosIndex + 1)].reverse().find(isFacebookMediaId);
    if (id) return { kind: "video", id, canonical: facebookVideoUrl(id) };
    return null;
  }

  // /photo.php?fbid=<id>, /photo/?fbid=<id>, /photo/<id>
  if (lower[0] === "photo.php" || lower[0] === "photo") {
    const id = url.searchParams.get("fbid") || parts[1];
    if (isFacebookMediaId(id)) {
      return { kind: "photo", id, canonical: `https://www.facebook.com/photo/?fbid=${id}` };
    }
    return null;
  }

  // /<user>/photos/a.<album>/<photo-id>/ and older /photos/<photo-id> forms.
  // Album-only URLs (no photo id) are rejected.
  if (lower.includes("photos")) {
    const id = [...parts].reverse().find((part) => isFacebookMediaId(part));
    if (id) {
      return { kind: "photo", id, canonical: `https://www.facebook.com/photo/?fbid=${id}` };
    }
    return null;
  }

  // /permalink.php?story_fbid=<id>&id=<owner>
  if (lower[0] === "permalink.php") {
    const story = url.searchParams.get("story_fbid");
    const owner = url.searchParams.get("id");
    if (isFacebookMediaId(story)) {
      const query = new URLSearchParams({ story_fbid: story });
      if (isFacebookMediaId(owner)) query.set("id", owner);
      return {
        kind: "post",
        id: story,
        canonical: `https://www.facebook.com/permalink.php?${query.toString()}`,
      };
    }
    return null;
  }

  // /story.php?story_fbid=<id> (owner id is optional)
  if (lower[0] === "story.php") {
    const story = url.searchParams.get("story_fbid");
    const owner = url.searchParams.get("id");
    if (isFacebookMediaId(story)) {
      const query = new URLSearchParams({ story_fbid: story });
      if (isFacebookMediaId(owner)) query.set("id", owner);
      return {
        kind: "post",
        id: story,
        canonical: `https://www.facebook.com/story.php?${query.toString()}`,
      };
    }
    return null;
  }

  // /<user>/posts/<id> and /groups/<group>/posts/<id>
  const postsIndex = lower.indexOf("posts");
  if (postsIndex === 1 && parts.length >= 3 && isFacebookMediaId(parts[2])) {
    const user = parts[0];
    if (/^[A-Za-z0-9.]{1,100}$/.test(user)) {
      return {
        kind: "post",
        id: parts[2],
        canonical: `https://www.facebook.com/${user}/posts/${parts[2]}/`,
      };
    }
  }
  if (
    lower[0] === "groups" &&
    lower[2] === "posts" &&
    isFacebookMediaId(parts[3]) &&
    /^\d{5,25}$/.test(parts[1] || "")
  ) {
    return {
      kind: "post",
      id: parts[3],
      canonical: `https://www.facebook.com/groups/${parts[1]}/posts/${parts[3]}/`,
    };
  }

  return null;
}

export function extractFacebookId(urlString) {
  return parseFacebookUrl(urlString)?.id || null;
}

export function isFacebookUrl(urlString) {
  return parseFacebookUrl(urlString) !== null;
}

/** "video" | "reel" | "photo" | "post" | "short" for a Facebook URL. */
export function getFacebookKind(urlString) {
  return parseFacebookUrl(urlString)?.kind || null;
}

/**
 * Canonical Facebook URL used for cache/status keys. Short links keep their
 * share token here and are resolved server-side when the job starts.
 */
export function normalizeFacebookUrl(urlString) {
  return parseFacebookUrl(urlString)?.canonical || null;
}

// ---------------------------------------------------------------------------
// Universal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the supported platform for a URL.
 * Returns "youtube", "x", "instagram", "facebook" or null.
 */
export function detectPlatform(urlString) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if (isYouTubeHost(host) && extractVideoId(urlString)) return "youtube";
  if (isXHost(host) && parseXStatus(urlString)) return "x";
  if (isInstagramHost(host) && parseInstagramMedia(urlString)) return "instagram";
  if (isFacebookHost(host) && parseFacebookUrl(urlString)) return "facebook";
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
  if (platform === "facebook") return normalizeFacebookUrl(urlString);
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
  if (platform === "facebook") return extractFacebookId(urlString);
  return null;
}
