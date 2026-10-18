import test from "node:test";
import assert from "node:assert/strict";

import {
  startDownload,
  setPhase,
  setProgressDetail,
  completeDownload,
  failDownload,
  getStatus,
  isActive,
  removeDownload,
  getActiveDownloads,
} from "../server/utils/downloadStatus.js";

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

test("startDownload creates a preparing entry", () => {
  startDownload("video", URL);
  const entry = getStatus("video", URL);

  assert.equal(entry.phase, "preparing");
  assert.equal(entry.progress, 0);
  assert.equal(entry.detail, null);
  assert.equal(entry.error, null);
  assert.equal(isActive("video", URL), true);
});

test("video and audio entries for the same URL are independent", () => {
  startDownload("audio", URL);
  setPhase("video", URL, "processing");
  setPhase("audio", URL, "failed", { error: "boom" });

  assert.equal(getStatus("video", URL).phase, "processing");
  assert.equal(getStatus("audio", URL).phase, "failed");
  assert.equal(getStatus("audio", URL).error, "boom");
  assert.equal(isActive("video", URL), true);
  assert.equal(isActive("audio", URL), false);

  removeDownload("video", URL);
  removeDownload("audio", URL);
});

test("setProgressDetail clamps progress and stores the detail text", () => {
  startDownload("video", URL);

  setProgressDetail("video", URL, 42.6, "Downloading from YouTube… 43%");
  let entry = getStatus("video", URL);
  assert.equal(entry.progress, 43);
  assert.equal(entry.detail, "Downloading from YouTube… 43%");

  setProgressDetail("video", URL, 250, null);
  entry = getStatus("video", URL);
  assert.equal(entry.progress, 100);
  assert.equal(entry.detail, "Downloading from YouTube… 43%", "detail should be preserved when null");

  setProgressDetail("video", URL, -5, "Starting");
  entry = getStatus("video", URL);
  assert.equal(entry.progress, 0);
  assert.equal(entry.detail, "Starting");

  removeDownload("video", URL);
});

test("setProgressDetail on unknown entries returns null", () => {
  assert.equal(setProgressDetail("video", "https://www.youtube.com/watch?v=zzzzzzzzzzz", 10, "x"), null);
});

test("completeDownload and failDownload close out an entry", () => {
  startDownload("video", URL);
  completeDownload("video", URL);
  assert.equal(getStatus("video", URL).phase, "complete");
  assert.equal(isActive("video", URL), false);

  startDownload("audio", URL);
  failDownload("audio", URL, "Requested quality is unavailable");
  assert.equal(getStatus("audio", URL).phase, "failed");
  assert.equal(getStatus("audio", URL).error, "Requested quality is unavailable");
  assert.equal(isActive("audio", URL), false);

  removeDownload("video", URL);
  removeDownload("audio", URL);
});

test("getActiveDownloads lists tracked entries and removeDownload deletes them", () => {
  startDownload("video", URL);
  const entries = getActiveDownloads();
  assert.ok(entries.some((e) => e.type === "video" && e.url === URL));

  removeDownload("video", URL);
  assert.equal(getStatus("video", URL), null);
  assert.ok(!getActiveDownloads().some((e) => e.type === "video" && e.url === URL));
});
