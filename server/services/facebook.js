/**
 * Public Facebook media support.
 *
 * Videos/reels are still downloaded with yt-dlp (see services/media.js).
 * This module is responsible for:
 *  - resolving fb.watch / share links without requiring a session,
 *  - reading public Open Graph metadata for image posts,
 *  - fetching the images through Facebook's CDN for previews and downloads.
 *
 * It deliberately uses the anonymous `facebookexternalhit` crawler user agent
 * and never sends cookies. Private/login-gated posts therefore fail with a
 * friendly error instead of being bypassed.
 */

import {
  detectPlatform,
  extractFacebookId,
  getFacebookKind,
  isFacebookUrl,
  normalizeFacebookUrl,
} from "../utils/validation.js";

const FACEBOOK_USER_AGENT = "facebookexternalhit/1.1";
const PAGE_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 6;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_GALLERY_IMAGES = 20;

function facebookError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function isFacebookHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch")
  );
}

function isFacebookCdnHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "fbcdn.net" || host.endsWith(".fbcdn.net");
}

/**
 * True for direct Facebook image-CDN URLs. Static assets, profile icons and
 * the safe_image proxy are excluded; they are not user media.
 */
export function isFacebookCdnImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let url;
  try {
    url = new URL(decodeUrl(rawUrl));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (!isFacebookCdnHostname(url.hostname)) return false;
  if (url.hostname.toLowerCase().startsWith("static.")) return false;

  const pathname = url.pathname.toLowerCase();
  if (pathname.includes("/rsrc.php/")) return false;
  if (pathname.includes("/safe_image.php")) return false;
  if (pathname.includes("/images/") && !pathname.includes("/v/")) return false;

  const inferred = dimensionsFromUrl(url);
  if (inferred && Math.min(inferred.width, inferred.height) > 0 && Math.min(inferred.width, inferred.height) < 200) {
    return false;
  }
  return true;
}

function decodeUrl(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)));
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function dimensionsFromUrl(url) {
  const params = url.searchParams;
  for (const key of ["stp", "cstp", "dst"]) {
    const value = params.get(key) || "";
    const match = value.match(/(?:^|_)s(\d+)x(\d+)(?:_|$)/i) || value.match(/^s(\d+)x(\d+)$/i);
    if (match) {
      return { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  return null;
}

function normalizeImageUrl(rawUrl) {
  const decoded = decodeUrl(rawUrl);
  if (!decoded) return null;
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    if (url.protocol === "http:") url.protocol = "https:";
    if (!isFacebookCdnImageUrl(url.toString())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function readMetaValue(meta, key) {
  return (meta[key.toLowerCase()] || [])[0] || null;
}

function readMetaAll(meta, key) {
  return meta[key.toLowerCase()] || [];
}

/**
 * Parse <meta> tags into a lower-cased property/name -> values map. Facebook
 * may emit several og:image tags for a multi-image post, so values are arrays.
 */
export function parseMetaTags(html) {
  const meta = Object.create(null);
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = Object.create(null);
    const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match;
    while ((match = attrPattern.exec(tag))) {
      attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    const content = attrs.content;
    if (!key || content == null) continue;
    if (!meta[key]) meta[key] = [];
    meta[key].push(content);
  }
  return meta;
}

function extractTitleTag(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : "";
}

function splitFacebookTitle(value) {
  const text = stripTags(value);
  if (!text) return { title: null, channel: null };
  const parts = text.split(/\s+\|\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { title: parts.slice(0, -1).join(" | "), channel: parts[parts.length - 1] };
  }
  return { title: text, channel: null };
}

function parsePublishedDate(meta) {
  const raw =
    readMetaValue(meta, "article:published_time") ||
    readMetaValue(meta, "og:published_time") ||
    readMetaValue(meta, "article:modified_time") ||
    readMetaValue(meta, "og:updated_time");
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function addImageCandidate(target, rawUrl, width, height) {
  const url = normalizeImageUrl(rawUrl);
  if (!url) return;
  let key;
  try {
    key = new URL(url).pathname;
  } catch {
    return;
  }
  const dimensions = dimensionsFromUrl(new URL(url));
  const explicitWidth = Number(width) || null;
  const explicitHeight = Number(height) || null;
  const next = {
    url,
    width: explicitWidth || dimensions?.width || null,
    height: explicitHeight || dimensions?.height || null,
  };
  const existing = target.get(key);
  if (!existing) {
    target.set(key, next);
    return;
  }

  // Facebook's thumbnail URLs encode a crop size (`s960x960`), while the
  // payload's explicit width/height describe the real photo (`960x720`).
  // Prefer the explicit metadata when the existing entry only had URL sizes.
  const existingUrlDimensions = dimensionsFromUrl(new URL(existing.url));
  const existingFromUrl =
    existingUrlDimensions &&
    existing.width === existingUrlDimensions.width &&
    existing.height === existingUrlDimensions.height;
  if ((explicitWidth || explicitHeight) && existingFromUrl) {
    existing.width = explicitWidth || existing.width;
    existing.height = explicitHeight || existing.height;
    return;
  }

  // Otherwise prefer the variant with known/larger dimensions, but keep the
  // first URL so the cover keeps Facebook's ordering.
  if ((next.width || 0) * (next.height || 0) > (existing.width || 0) * (existing.height || 0)) {
    existing.width = next.width || existing.width;
    existing.height = next.height || existing.height;
  }
}

function extractImageCandidatesFromHtml(html, { isVideo = false } = {}) {
  const found = new Map();
  const text = String(html || "");
  const keyPattern = /"(?:photo_image|image|image_url|images|photo_images|all_images|preview_image|thumbnail_image|uri|src|url)"\s*:\s*"((?:\\.|[^"\\])+)"/gi;

  let match;
  while ((match = keyPattern.exec(text))) {
    const raw = match[1];
    if (!/fbcdn\.net/i.test(raw)) continue;
    // Width/height usually follow the URL inside the same JSON object. Reading
    // only forward avoids borrowing the previous image's dimensions when a
    // gallery lists several objects back to back.
    const context = text.slice(match.index, match.index + 500);
    const widthMatch = context.match(/"width"\s*:\s*(\d+)/i);
    const heightMatch = context.match(/"height"\s*:\s*(\d+)/i);
    addImageCandidate(found, raw, widthMatch?.[1], heightMatch?.[1]);
  }

  // Some payloads contain raw/escaped CDN URLs without a recognised key.
  const rawPattern = /https?:\\\/\\\/[^"'\s<>]+?fbcdn\.net[^"'\s<>]*/gi;
  while ((match = rawPattern.exec(text))) {
    addImageCandidate(found, match[0], null, null);
  }

  const images = [...found.values()].filter((image) => {
    if (!image.width || !image.height) return true;
    if (Math.min(image.width, image.height) < 200) return false;
    // t15.* files are video thumbnails. Do not offer them as photos on an
    // image-only page.
    if (!isVideo && /\/v\/t15\./i.test(image.url)) return false;
    return true;
  });

  return images.slice(0, MAX_GALLERY_IMAGES);
}

/**
 * Parse a public Facebook page's metadata. Exported for unit tests so the
 * parser can be verified without network access.
 */
export function parseFacebookPage(html, pageUrl = "") {
  const meta = parseMetaTags(html);
  const ogType = (readMetaValue(meta, "og:type") || "").toLowerCase();
  const titleParts = splitFacebookTitle(readMetaValue(meta, "og:title") || extractTitleTag(html));
  const description = stripTags(readMetaValue(meta, "og:description") || readMetaValue(meta, "description"));
  const siteName = stripTags(readMetaValue(meta, "og:site_name"));
  const canonicalUrl = decodeUrl(readMetaValue(meta, "og:url") || pageUrl);
  const published = parsePublishedDate(meta);

  const videoSignals =
    /^video/.test(ogType) ||
    Boolean(
      readMetaValue(meta, "og:video") ||
        readMetaValue(meta, "og:video:url") ||
        readMetaValue(meta, "og:video:secure_url") ||
        readMetaValue(meta, "twitter:player")
    );
  const isVideo = videoSignals || /"is_video"\s*:\s*true/i.test(html);

  const found = new Map();
  const ogImages = [
    ...readMetaAll(meta, "og:image"),
    ...readMetaAll(meta, "og:image:secure_url"),
    ...readMetaAll(meta, "twitter:image"),
    ...readMetaAll(meta, "image"),
  ];
  const ogWidths = readMetaAll(meta, "og:image:width");
  const ogHeights = readMetaAll(meta, "og:image:height");
  ogImages.forEach((url, index) => {
    addImageCandidate(found, url, ogWidths[index], ogHeights[index]);
  });

  const linkImages = String(html || "").match(/<link\b[^>]*rel=["']image_src["'][^>]*>/gi) || [];
  for (const tag of linkImages) {
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) addImageCandidate(found, href[1], null, null);
  }

  for (const image of extractImageCandidatesFromHtml(html, { isVideo })) {
    addImageCandidate(found, image.url, image.width, image.height);
  }

  const images = [...found.values()].slice(0, MAX_GALLERY_IMAGES);
  const hasPhotoMetadata =
    /"(?:photo_image|photo_images|all_images|image_urls|images)"\s*:\s*[\[{]/i.test(html) ||
    /\/photo(?:\.php|\/)/i.test(canonicalUrl || pageUrl);

  return {
    title: titleParts.title,
    channel: titleParts.channel || siteName || null,
    description: description || null,
    ogType,
    isVideo,
    canonicalUrl,
    uploadDate: published,
    images,
    hasPhotoMetadata,
    isLoginPage: isLoginHtml(html, pageUrl),
  };
}

function isLoginHtml(html, pageUrl = "") {
  let pathname = "";
  try {
    pathname = new URL(pageUrl).pathname.toLowerCase();
  } catch {}
  if (pathname.includes("/login") || pathname.includes("/checkpoint")) return true;
  const source = String(html || "");
  return (
    /id=["']login_form["']/i.test(source) ||
    /name=["']login_form["']/i.test(source) ||
    /"login_form"\s*:/i.test(source) ||
    /you must log in to continue/i.test(source) ||
    /log in to facebook/i.test(source)
  );
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

async function readBufferLimited(response, maxBytes) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw facebookError("Facebook returned a non-image response.", 502, "UPSTREAM_FAILURE");
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw facebookError("This Facebook image is too large.", 413, "IMAGE_TOO_LARGE");
    return { buffer, contentType };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        throw facebookError("This Facebook image is too large.", 413, "IMAGE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return { buffer: Buffer.concat(chunks), contentType };
}

function timeoutSignal(ms, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchWithRedirects(startUrl, { signal, headers, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = startUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers,
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current };
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { response, finalUrl: current };
      }
      let host;
      try {
        host = new URL(next).hostname;
      } catch {
        return { response, finalUrl: current };
      }
      if (!isFacebookHostname(host) && !isFacebookCdnHostname(host)) {
        throw facebookError("Facebook redirected to an unsupported host.", 502, "UPSTREAM_FAILURE");
      }
      current = next;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw facebookError("Facebook redirected too many times.", 502, "UPSTREAM_FAILURE");
}

/**
 * Resolve a short Facebook link and read its public HTML. `finalUrl` is the
 * page URL the download job should use; the original URL remains the cache key.
 */
export async function fetchFacebookPage(rawUrl, { signal = null } = {}) {
  if (!isFacebookUrl(rawUrl)) {
    throw facebookError("Unsupported Facebook link.", 400, "UNSUPPORTED_URL");
  }
  const startUrl = normalizeFacebookUrl(rawUrl) || rawUrl;
  const timeout = timeoutSignal(PAGE_TIMEOUT_MS, signal);
  try {
    const { response, finalUrl } = await fetchWithRedirects(startUrl, {
      signal: timeout.signal,
      headers: {
        "User-Agent": FACEBOOK_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.status === 404) {
      throw facebookError(
        "This Facebook post is unavailable. It may have been deleted or is not public.",
        404,
        "POST_UNAVAILABLE"
      );
    }
    if (response.status === 429) {
      throw facebookError("Facebook is rate-limiting this server. Wait a minute and try again.", 429, "RATE_LIMITED");
    }
    if (response.status >= 400) {
      throw facebookError(
        "Facebook returned an error for this link. Try another public post or try again later.",
        502,
        "UPSTREAM_FAILURE"
      );
    }

    const html = await readTextLimited(response, MAX_HTML_BYTES);
    const page = parseFacebookPage(html, finalUrl);
    if (page.isLoginPage) {
      throw facebookError(
        "This Facebook post is private or requires sign-in. Grab a Clip only supports public posts.",
        403,
        "LOGIN_REQUIRED"
      );
    }
    return { ...page, resolvedUrl: finalUrl, html, status: response.status };
  } finally {
    timeout.cleanup();
  }
}

function publicImageList(images) {
  return images.map((image, index) => ({
    index,
    width: image.width || null,
    height: image.height || null,
  }));
}

/**
 * Build the /api/info shape for a public image post. Kept separate from the
 * network code so it can be unit-tested with synthetic metadata.
 */
export function buildFacebookImageInfo(page, { requestedUrl, resolvedUrl } = {}) {
  const images = Array.isArray(page?.images) ? page.images.slice(0, MAX_GALLERY_IMAGES) : [];
  if (images.length === 0) {
    throw facebookError(
      "No public video or image was found in this Facebook link. The post may be private or use an unsupported format.",
      404,
      "POST_UNAVAILABLE"
    );
  }

  const titleParts = splitFacebookTitle(page.title);
  const resolved = resolvedUrl || page.canonicalUrl || requestedUrl;
  const mediaId = extractFacebookId(resolved) || extractFacebookId(requestedUrl) || null;

  return {
    platform: "facebook",
    mediaType: images.length > 1 ? "gallery" : "image",
    videoId: mediaId,
    title: titleParts.title || "Facebook photo",
    channel: titleParts.channel || page.channel || "Facebook",
    uploader: null,
    channelId: null,
    duration: null,
    durationFormatted: null,
    thumbnail: null,
    description: page.description || null,
    viewCount: null,
    likeCount: null,
    uploadDate: page.uploadDate || null,
    uploadDateFormatted: page.uploadDate || null,
    formats: [],
    formatsCompatible: [],
    audioFormats: [],
    audioSource: null,
    imageCount: images.length,
    images: publicImageList(images),
    // Internal fields are used by the image/download routes only.
    _images: images,
    _downloadUrl: resolved,
    _sourceUrl: resolved,
    _rawData: null,
  };
}

/**
 * Fetch one public Facebook CDN image into memory. Used by the preview proxy,
 * single-image download and ZIP builder. The caller only supplies an index
 * against cached info, never an arbitrary URL.
 */
export async function fetchFacebookImage(imageUrl, { signal = null } = {}) {
  if (!isFacebookCdnImageUrl(imageUrl)) {
    throw facebookError("Unsupported Facebook image URL.", 400, "UNSUPPORTED_URL");
  }
  const timeout = timeoutSignal(IMAGE_TIMEOUT_MS, signal);
  try {
    const { response, finalUrl } = await fetchWithRedirects(imageUrl, {
      signal: timeout.signal,
      headers: {
        "User-Agent": FACEBOOK_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: "https://www.facebook.com/",
      },
      maxRedirects: 4,
    });

    if (!isFacebookCdnHostname(new URL(finalUrl).hostname)) {
      throw facebookError("Facebook redirected the image to an unsupported host.", 502, "UPSTREAM_FAILURE");
    }
    if (response.status === 404 || response.status === 410) {
      throw facebookError("This Facebook image is no longer available.", 404, "IMAGE_UNAVAILABLE");
    }
    if (response.status === 429) {
      throw facebookError("Facebook is rate-limiting image downloads. Wait a minute and try again.", 429, "RATE_LIMITED");
    }
    if (!response.ok) {
      throw facebookError("Facebook returned an error while fetching this image.", 502, "UPSTREAM_FAILURE");
    }

    const result = await readBufferLimited(response, MAX_IMAGE_BYTES);
    if (result.buffer.length === 0) {
      throw facebookError("Facebook returned an empty image.", 502, "UPSTREAM_FAILURE");
    }
    return { ...result, finalUrl };
  } finally {
    timeout.cleanup();
  }
}

function pickVideoErrorForImageFallback(error) {
  const code = error?.code;
  return [
    "PRIVATE_VIDEO",
    "LOGIN_REQUIRED",
    "AGE_RESTRICTED",
    "MEMBERS_ONLY",
    "GEO_BLOCKED",
    "RATE_LIMITED",
    "BOT_CHECK",
  ].includes(code);
}

/**
 * Facebook dispatcher: use yt-dlp for videos, public metadata for images.
 * `getVideoInfo` is injected by services/media.js so this module never imports
 * yt-dlp (and tests can replace the network extractor).
 */
export async function getFacebookInfo(rawUrl, options = {}) {
  const { getVideoInfo: loadVideo, signal = null } = options;
  if (typeof loadVideo !== "function") {
    throw facebookError("Facebook video extraction is not configured.", 500, "UNKNOWN");
  }

  const kind = getFacebookKind(rawUrl);
  const normalized = normalizeFacebookUrl(rawUrl) || rawUrl;

  // Direct video/reel links are the common case and yt-dlp already returns the
  // best metadata. Only fall back to images if the link really is not a video.
  if (kind === "video" || kind === "reel") {
    try {
      const info = await loadVideo(normalized, { signal });
      return { ...info, _downloadUrl: info._downloadUrl || normalized };
    } catch (error) {
      if (pickVideoErrorForImageFallback(error)) throw error;
      let page;
      try {
        page = await fetchFacebookPage(normalized, { signal });
      } catch {
        throw error;
      }
      if (!page.isVideo && page.images.length > 0) {
        return buildFacebookImageInfo(page, { requestedUrl: rawUrl, resolvedUrl: page.resolvedUrl });
      }
      throw error;
    }
  }

  // Photo posts are not supported by yt-dlp at all, so skip it entirely.
  if (kind === "photo") {
    const page = await fetchFacebookPage(normalized, { signal });
    if (page.isVideo) {
      const info = await loadVideo(page.resolvedUrl, { signal });
      return { ...info, _downloadUrl: info._downloadUrl || page.resolvedUrl };
    }
    return buildFacebookImageInfo(page, { requestedUrl: rawUrl, resolvedUrl: page.resolvedUrl });
  }

  // /share/..., fb.watch and generic post links need the resolved page first
  // to know whether this is a video, a single image or a gallery.
  const page = await fetchFacebookPage(normalized, { signal });
  if (page.isVideo) {
    const info = await loadVideo(page.resolvedUrl, { signal });
    return { ...info, _downloadUrl: info._downloadUrl || page.resolvedUrl };
  }
  if (page.images.length > 0) {
    return buildFacebookImageInfo(page, { requestedUrl: rawUrl, resolvedUrl: page.resolvedUrl });
  }

  // Last chance: some public posts expose video formats without video OG tags.
  try {
    const info = await loadVideo(page.resolvedUrl, { signal });
    return { ...info, _downloadUrl: info._downloadUrl || page.resolvedUrl };
  } catch (error) {
    throw facebookError(
      "No public video or image was found in this Facebook link. The post may be private or use an unsupported format.",
      error?.status && error.status >= 400 && error.status < 500 ? error.status : 404,
      error?.code || "POST_UNAVAILABLE"
    );
  }
}

export const FACEBOOK_LIMITS = {
  MAX_GALLERY_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_HTML_BYTES,
};
