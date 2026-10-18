import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVideoId,
  isValidVideoId,
  isYouTubeUrl,
  normalizeYouTubeUrl,
} from "../shared/validator.js";

import {
  validateDownloadQuery,
  validateInfoRequest,
  sanitizeFilename,
  sanitizeAsciiFilename,
  isValidFormatId,
} from "../server/utils/validation.js";

// ---------------------------------------------------------------------------
// shared/validator.js
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

test("validateDownloadQuery rejects unsupported heights", () => {
  for (const bad of ["999", "2160", "abc", "-1"]) {
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

test("validateDownloadQuery requires a valid YouTube URL", () => {
  assert.equal(validateDownloadQuery({}).valid, false);
  assert.equal(validateDownloadQuery({ url: "" }).valid, false);
  assert.equal(validateDownloadQuery({ url: "https://vimeo.com/12345" }).valid, false);
});

test("validateInfoRequest mirrors the download URL validation", () => {
  const ok = validateInfoRequest({ url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(ok.valid, true);
  assert.equal(ok.videoId, "dQw4w9WgXcQ");

  assert.equal(validateInfoRequest({}).valid, false);
  assert.equal(validateInfoRequest({ url: "nope" }).valid, false);
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
  assert.equal(isValidFormatId("137+140"), false);
  assert.equal(isValidFormatId("rm -rf /"), false);
  assert.equal(isValidFormatId(""), false);
});
