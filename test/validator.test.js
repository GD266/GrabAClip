import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVideoId,
  isValidVideoId,
  isYouTubeUrl,
  normalizeYouTubeUrl,
  detectPlatform,
  isSupportedMediaUrl,
  normalizeMediaUrl,
  extractMediaId,
  isXUrl,
  normalizeXUrl,
  isInstagramUrl,
  normalizeInstagramUrl,
} from "../public/shared/validator.js";

import {
  validateDownloadQuery,
  validateInfoRequest,
  sanitizeFilename,
  sanitizeAsciiFilename,
  isValidFormatId,
} from "../server/utils/validation.js";

// ---------------------------------------------------------------------------
// shared/validator.js (served from public/shared/)
// ---------------------------------------------------------------------------

test("extractVideoId handles watch, short, embed and youtu.be URLs", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(extractVideoId("https://www.youtube.com/embed/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(extractVideoId("https://m.youtube.com/watch?v=jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(extractVideoId("https://music.youtube.com/watch?v=jNQXAC9IVRw"), "jNQXAC9IVRw");
});

test("extractVideoId rejects non-YouTube and malformed URLs", () => {
  assert.equal(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=tooshort"), null);
  assert.equal(extractVideoId("not a url"), null);
  assert.equal(extractVideoId(""), null);
  assert.equal(extractVideoId(null), null);
});

test("isValidVideoId enforces the 11-char id format", () => {
  assert.equal(isValidVideoId("dQw4w9WgXcQ"), true);
  assert.equal(isValidVideoId("abc"), false);
  assert.equal(isValidVideoId("dQw4w9WgXcQ!"), false);
});

test("isYouTubeUrl accepts YouTube hosts only", () => {
  assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(isYouTubeUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), true);
  assert.equal(isYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ"), false);
  assert.equal(isYouTubeUrl("javascript:alert(1)"), false);
  assert.equal(isYouTubeUrl("ftp://youtube.com/watch?v=dQw4w9WgXcQ"), false);
  assert.equal(isYouTubeUrl(""), false);
  assert.equal(isYouTubeUrl(null), false);
});

test("normalizeYouTubeUrl produces the canonical watch URL", () => {
  assert.equal(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?si=x"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeYouTubeUrl("garbage"), null);
});

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

test("normalizeXUrl canonicalises status links and keeps the video index", () => {
  assert.equal(
    normalizeXUrl("https://twitter.com/NASA/status/1234567890?lang=en"),
    "https://x.com/NASA/status/1234567890/video/1"
  );
  assert.equal(
    normalizeXUrl("https://x.com/NASA/status/1234567890/video/2"),
    "https://x.com/NASA/status/1234567890/video/2"
  );
  assert.equal(
    normalizeXUrl("https://mobile.twitter.com/i/web/status/1234567890"),
    "https://x.com/i/web/status/1234567890/video/1"
  );
  assert.equal(
    normalizeMediaUrl("https://x.com/NASA/status/1234567890"),
    "https://x.com/NASA/status/1234567890/video/1"
  );
  assert.equal(normalizeXUrl("https://x.com/NASA"), null);
  assert.equal(normalizeXUrl("https://x.com.evil.example/NASA/status/1234567890"), null);
  assert.equal(normalizeXUrl("https://x.com/NASA/status/not-a-number"), null);
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

test("normalizeInstagramUrl handles reels, posts, TV and username prefixes", () => {
  assert.equal(
    normalizeInstagramUrl("https://www.instagram.com/reel/CDUMkliABpa/?igsh=x"),
    "https://www.instagram.com/reel/CDUMkliABpa/"
  );
  assert.equal(
    normalizeInstagramUrl("https://instagram.com/reels/CDUMkliABpa/"),
    "https://www.instagram.com/reel/CDUMkliABpa/"
  );
  assert.equal(
    normalizeInstagramUrl("https://www.instagram.com/someuser/reel/CDUMkliABpa/"),
    "https://www.instagram.com/reel/CDUMkliABpa/"
  );
  assert.equal(
    normalizeInstagramUrl("https://www.instagram.com/p/BQ0eAlwhDrw/"),
    "https://www.instagram.com/p/BQ0eAlwhDrw/"
  );
  assert.equal(
    normalizeInstagramUrl("https://www.instagram.com/tv/BkfuX9UB-eK/"),
    "https://www.instagram.com/tv/BkfuX9UB-eK/"
  );
  assert.equal(normalizeInstagramUrl("https://www.instagram.com/someuser/"), null);
  assert.equal(normalizeInstagramUrl("https://www.instagram.com/stories/someuser/123/"), null);
  assert.equal(normalizeInstagramUrl("https://www.instagram.com/reels/audio/1234567890/"), null);
  assert.equal(normalizeInstagramUrl("https://instagram.com.evil.example/reel/CDUMkliABpa/"), null);
});

// ---------------------------------------------------------------------------
// Universal helpers
// ---------------------------------------------------------------------------

test("detectPlatform and isSupportedMediaUrl cover all three platforms", () => {
  assert.equal(detectPlatform("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(detectPlatform("https://x.com/NASA/status/1234567890"), "x");
  assert.equal(detectPlatform("https://www.instagram.com/reel/CDUMkliABpa/"), "instagram");
  assert.equal(detectPlatform("https://vimeo.com/12345"), null);
  assert.equal(detectPlatform("javascript:alert(1)"), null);

  assert.equal(isSupportedMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(isSupportedMediaUrl("https://x.com/NASA/status/1234567890"), true);
  assert.equal(isSupportedMediaUrl("https://www.instagram.com/p/BQ0eAlwhDrw/"), true);
  assert.equal(isSupportedMediaUrl("https://vimeo.com/12345"), false);
});

test("extractMediaId returns a stable id per platform", () => {
  assert.equal(extractMediaId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractMediaId("https://x.com/NASA/status/1234567890/video/2"), "1234567890");
  assert.equal(extractMediaId("https://www.instagram.com/reel/CDUMkliABpa/"), "CDUMkliABpa");
  assert.equal(extractMediaId("https://vimeo.com/12345"), null);
});

test("isXUrl and isInstagramUrl reject lookalike and profile URLs", () => {
  assert.equal(isXUrl("https://x.com/NASA/status/1234567890"), true);
  assert.equal(isXUrl("https://x.com/NASA"), false);
  assert.equal(isInstagramUrl("https://www.instagram.com/reel/CDUMkliABpa/"), true);
  assert.equal(isInstagramUrl("https://www.instagram.com/someuser/"), false);
});

// ---------------------------------------------------------------------------
// validateDownloadQuery
// ---------------------------------------------------------------------------

test("validateDownloadQuery accepts a numeric height", () => {
  const r = validateDownloadQuery({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", height: "720" });
  assert.equal(r.valid, true);
  assert.equal(r.height, 720);
  assert.equal(r.formatId, null);
  assert.equal(r.normalizedUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("validateDownloadQuery accepts a height with a p suffix and all UI steps", () => {
  for (const [input, expected] of [
    ["144p", 144],
    ["240", 240],
    ["360", 360],
    ["480", 480],
    ["720p", 720],
    ["1080", 1080],
  ]) {
    const r = validateDownloadQuery({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", height: input });
    assert.equal(r.valid, true, `height ${input} should be valid`);
    assert.equal(r.height, expected);
  }
});

test("validateDownloadQuery accepts source-specific quality heights", () => {
  for (const [url, input, expected] of [
    ["https://x.com/NASA/status/1234567890", "270", 270],
    ["https://www.instagram.com/reel/CDUMkliABpa/", "504p", 504],
  ]) {
    const r = validateDownloadQuery({ url, height: input });
    assert.equal(r.valid, true, `height ${input} should be valid`);
    assert.equal(r.height, expected);
  }
});

test("validateDownloadQuery rejects unsupported heights", () => {
  for (const bad of ["100", "1081", "2160", "abc", "-1"]) {
    const r = validateDownloadQuery({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", height: bad });
    assert.equal(r.valid, false, `height ${bad} should be invalid`);
  }
});

test("validateDownloadQuery accepts a legacy formatId", () => {
  const r = validateDownloadQuery({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", formatId: "137" });
  assert.equal(r.valid, true);
  assert.equal(r.formatId, "137");
  assert.equal(r.height, null);
});

test("validateDownloadQuery validates every supported platform", () => {
  const x = validateDownloadQuery({ url: "https://x.com/NASA/status/1234567890", height: "720" });
  assert.equal(x.valid, true);
  assert.equal(x.platform, "x");
  assert.equal(x.normalizedUrl, "https://x.com/NASA/status/1234567890/video/1");

  const instagram = validateDownloadQuery({
    url: "https://www.instagram.com/reel/CDUMkliABpa/",
    height: "504",
  });
  assert.equal(instagram.valid, true);
  assert.equal(instagram.platform, "instagram");
  assert.equal(instagram.normalizedUrl, "https://www.instagram.com/reel/CDUMkliABpa/");

  assert.equal(validateDownloadQuery({ url: "https://vimeo.com/12345" }).valid, false);
});

test("validateDownloadQuery requires a valid supported URL", () => {
  assert.equal(validateDownloadQuery({}).valid, false);
  assert.equal(validateDownloadQuery({ url: "" }).valid, false);
  assert.equal(validateDownloadQuery({ url: "https://vimeo.com/12345" }).valid, false);
});

test("validateInfoRequest mirrors the download URL validation", () => {
  const ok = validateInfoRequest({ url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(ok.valid, true);
  assert.equal(ok.platform, "youtube");
  assert.equal(ok.videoId, "dQw4w9WgXcQ");

  const x = validateInfoRequest({ url: "https://twitter.com/NASA/status/1234567890" });
  assert.equal(x.valid, true);
  assert.equal(x.platform, "x");
  assert.equal(x.normalizedUrl, "https://x.com/NASA/status/1234567890/video/1");

  const instagram = validateInfoRequest({ url: "https://www.instagram.com/p/BQ0eAlwhDrw/" });
  assert.equal(instagram.valid, true);
  assert.equal(instagram.platform, "instagram");
  assert.equal(instagram.videoId, "BQ0eAlwhDrw");

  assert.equal(validateInfoRequest({}).valid, false);
  assert.equal(validateInfoRequest({ url: "nope" }).valid, false);
  assert.equal(validateInfoRequest({ url: "https://vimeo.com/12345" }).valid, false);
});

// ---------------------------------------------------------------------------
// filename sanitising
// ---------------------------------------------------------------------------

test("sanitizeFilename strips illegal characters and path separators", () => {
  const name = sanitizeFilename('My/Video: <Cool> "Test"?|*');
  assert.doesNotMatch(name, /[<>:"|?*\\/]/);
  assert.ok(name.length > 0);
});

test("sanitizeFilename truncates long names and fixes Windows edge cases", () => {
  assert.equal(sanitizeFilename("x".repeat(300)).length, 100);
  assert.equal(sanitizeFilename(""), "video");
  assert.equal(sanitizeFilename(null), "video");
  assert.equal(sanitizeFilename("...hidden"), "hidden");
  assert.equal(sanitizeFilename("trailing dots..."), "trailing dots");
});

test("sanitizeAsciiFilename keeps the Content-Disposition quoted string safe", () => {
  const ascii = sanitizeAsciiFilename("Café — Música “Bonita”");
  assert.match(ascii, /^[\x20-\x7E]+$/);
  assert.doesNotMatch(ascii, /[";\\]/);

  assert.equal(sanitizeAsciiFilename('bad"name";evil\\path'), "bad_name__evil_path");
});

test("isValidFormatId allows typical yt-dlp ids only", () => {
  assert.equal(isValidFormatId("137"), true);
  assert.equal(isValidFormatId("hls-123_4"), true);
  assert.equal(isValidFormatId("dash-1254645688899587a"), true);
  assert.equal(isValidFormatId("137+140"), false);
  assert.equal(isValidFormatId("rm -rf /"), false);
  assert.equal(isValidFormatId(""), false);
  assert.equal(isValidFormatId("a".repeat(65)), false);
});
