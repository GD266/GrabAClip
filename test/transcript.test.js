import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTranscriptContent } from "../server/services/transcript.js";

test("normalizeTranscriptContent turns WebVTT into plain text", () => {
  const vtt = [
    "WEBVTT",
    "Kind: captions",
    "Language: en",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "Hello <c>world</c>",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "this is",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "♪ [Music] ♪",
    "",
    "00:00:06.000 --> 00:00:08.000",
    "a test.",
    "",
  ].join("\n");

  const text = normalizeTranscriptContent(vtt);

  assert.ok(text.includes("Hello world"), `unexpected text: ${text}`);
  assert.ok(text.includes("this is"));
  assert.ok(text.includes("a test."));
  assert.ok(!text.includes("WEBVTT"));
  assert.ok(!text.includes("-->"));
  assert.ok(!text.includes("♪"));
  assert.ok(!text.includes("[Music]"));
});

test("normalizeTranscriptContent handles SRT cue indexes and CRLF", () => {
  const srt = [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "First line",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "Second line",
    "",
  ].join("\r\n");

  const text = normalizeTranscriptContent(srt);
  assert.ok(text.includes("First line"));
  assert.ok(text.includes("Second line"));
  assert.ok(!text.includes("00:00"));
});

test("normalizeTranscriptContent dedupes incremental captions", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "the quick",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "the quick brown fox",
    "",
  ].join("\n");

  const text = normalizeTranscriptContent(vtt);
  assert.equal(text.includes("the quick the quick brown fox"), false, `duplicated cue: ${text}`);
  assert.ok(text.includes("the quick brown fox"), `unexpected text: ${text}`);
});

test("normalizeTranscriptContent returns an empty string for bad input", () => {
  assert.equal(normalizeTranscriptContent(""), "");
  assert.equal(normalizeTranscriptContent(null), "");
  assert.equal(normalizeTranscriptContent(42), "");
});
