import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  buildVideoFormats,
  buildAudioFormats,
  pickAudioSource,
  classifyYtDlpError,
  createJobOutputParser,
  buildVideoAttempts,
  buildAudioAttempts,
  isFatalDownloadError,
  runMediaJob,
  startVideoDownload,
  cleanupJobDir,
} from "../server/services/ytdlp.js";

// ---------------------------------------------------------------------------
// Fixtures modelled on real yt-dlp --dump-json output
// ---------------------------------------------------------------------------

const dashVideo240 = {
  format_id: "133",
  ext: "mp4",
  protocol: "https",
  vcodec: "avc1.4d400d",
  acodec: "none",
  height: 240,
  tbr: 200,
  fps: 30,
};

const dashVideo240Av1 = {
  format_id: "394",
  ext: "mp4",
  protocol: "https",
  vcodec: "av01.0.00M.08",
  acodec: "none",
  height: 240,
  tbr: 150,
  fps: 30,
};

const dashAudio140 = {
  format_id: "140",
  ext: "m4a",
  protocol: "https",
  vcodec: "none",
  acodec: "mp4a.40.2",
  abr: 128,
};

const hls93 = {
  format_id: "93",
  ext: "mp4",
  protocol: "m3u8_native",
  vcodec: "avc1.4d401e",
  acodec: "mp4a.40.2",
  height: 360,
  tbr: 500,
  fps: 30,
};

const hls96 = {
  format_id: "96",
  ext: "mp4",
  protocol: "m3u8_native",
  vcodec: "avc1.640028",
  acodec: "mp4a.40.2",
  height: 1080,
  tbr: 3000,
  fps: 30,
};

const hls97 = {
  format_id: "97",
  ext: "mp4",
  protocol: "m3u8_native",
  vcodec: "av01.0.08M.08",
  acodec: "mp4a.40.2",
  height: 2160,
  tbr: 10000,
  fps: 30,
};

const progressive18 = {
  format_id: "18",
  ext: "mp4",
  protocol: "https",
  vcodec: "avc1.42001E",
  acodec: "mp4a.40.2",
  height: 360,
  tbr: 600,
  fps: 30,
};

// ---------------------------------------------------------------------------
// buildVideoFormats
// ---------------------------------------------------------------------------

test("buildVideoFormats returns [] for empty/invalid input", () => {
  assert.deepEqual(buildVideoFormats([]), []);
  assert.deepEqual(buildVideoFormats(null), []);
  assert.deepEqual(buildVideoFormats(undefined), []);
});

test("buildVideoFormats prefers muxed HLS over merging DASH", () => {
  const plans = buildVideoFormats([dashVideo240, dashAudio140, hls93, progressive18]);
  const at360 = plans.find((p) => p.height === 360);

  assert.ok(at360, "expected a 360p plan");
  assert.equal(at360.kind, "muxed");
  assert.equal(at360.source, "hls");
  assert.equal(at360.formatId, "93");
  assert.equal(at360.hasAudio, true);
  assert.equal(at360.ext, "mp4");
});

test("buildVideoFormats merges DASH video-only with best audio when no muxed HLS exists", () => {
  const plans = buildVideoFormats([dashVideo240, dashAudio140]);
  assert.equal(plans.length, 1);

  const plan = plans[0];
  assert.equal(plan.height, 240);
  assert.equal(plan.kind, "merge");
  assert.equal(plan.source, "dash");
  assert.equal(plan.formatId, "133+140");
  assert.deepEqual(plan.formatIds, ["133", "140"]);
  assert.equal(plan.acodec, "mp4a.40.2");
});

test("buildVideoFormats prefers H.264 over AV1 when merging", () => {
  const plans = buildVideoFormats([dashVideo240Av1, dashVideo240, dashAudio140]);
  const plan = plans.find((p) => p.height === 240);
  assert.equal(plan.formatIds[0], "133");
});

test("buildVideoFormats falls back to progressive formats last", () => {
  const plans = buildVideoFormats([progressive18]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "progressive");
  assert.equal(plans[0].source, "progressive");
  assert.equal(plans[0].formatId, "18");
});

test("buildVideoFormats caps heights at 1080p and sorts best first", () => {
  const plans = buildVideoFormats([hls93, hls96, hls97]);
  assert.deepEqual(
    plans.map((p) => p.height),
    [1080, 360]
  );
  assert.equal(plans[0].formatId, "96");
});

test("buildVideoFormats ignores storyboards and mhtml", () => {
  const storyboard = {
    format_id: "sb0",
    ext: "mhtml",
    protocol: "mhtml",
    vcodec: "none",
    acodec: "none",
    height: 90,
    format_note: "storyboard",
  };
  const plans = buildVideoFormats([storyboard, hls93]);
  assert.deepEqual(
    plans.map((p) => p.height),
    [360]
  );
});

test("buildVideoFormats estimates size from duration and bitrate", () => {
  const [plan] = buildVideoFormats([hls93], 100);
  // 500 kbps * 100 s / 8 = 6,250,000 bytes
  assert.equal(plan.estimatedSize, 6250000);
});

test("buildVideoFormats uses filesize when yt-dlp reports it", () => {
  const [plan] = buildVideoFormats([{ ...hls93, filesize: 123456 }], 100);
  assert.equal(plan.estimatedSize, 123456);
});

// ---------------------------------------------------------------------------
// Audio options / source selection
// ---------------------------------------------------------------------------

test("buildAudioFormats offers m4a, three MP3 bitrates and wav", () => {
  const options = buildAudioFormats();
  assert.deepEqual(
    options.map((o) => o.label),
    ["M4A", "MP3 320", "MP3 192", "MP3 128", "WAV"]
  );
  assert.deepEqual(
    options.filter((o) => o.id === "mp3").map((o) => o.quality),
    [320, 192, 128]
  );
});

test("pickAudioSource prefers the smallest AAC-LC HLS variant", () => {
  const source = pickAudioSource([
    { ...hls96, acodec: "mp4a.40.2" },
    hls93,
    { ...dashAudio140, ext: "m4a" },
  ]);
  assert.equal(source.formatId, "93");
  assert.match(source.label, /AAC 128k/);
});

test("pickAudioSource falls back to HE-AAC HLS then DASH audio", () => {
  const heAac = { ...hls93, format_id: "92", acodec: "mp4a.40.5" };
  const fromHls = pickAudioSource([heAac, dashAudio140]);
  assert.equal(fromHls.formatId, "92");

  const fromDash = pickAudioSource([dashAudio140]);
  assert.equal(fromDash.formatId, "140");
  assert.match(fromDash.label, /DASH audio/);

  assert.equal(pickAudioSource([]), null);
});

// ---------------------------------------------------------------------------
// classifyYtDlpError
// ---------------------------------------------------------------------------

test("classifyYtDlpError maps 403 media blocks to a retryable 502", () => {
  const r = classifyYtDlpError("ERROR: unable to download video data: HTTP Error 403: Forbidden", 1);
  assert.equal(r.status, 502);
  assert.match(r.message, /403/);
});

test("classifyYtDlpError maps unavailable/private/age-restricted videos", () => {
  assert.equal(classifyYtDlpError("ERROR: Video unavailable", 1).status, 404);
  assert.equal(classifyYtDlpError("ERROR: Private video. Sign in to view", 1).status, 403);
  assert.equal(classifyYtDlpError("ERROR: Sign in to confirm your age", 1).status, 403);
});

test("classifyYtDlpError maps format errors to 400 and unknown errors to 500", () => {
  assert.equal(classifyYtDlpError("ERROR: Requested format is not available", 1).status, 400);
  assert.equal(classifyYtDlpError("ERROR: something totally unexpected", 1).status, 500);
});

// ---------------------------------------------------------------------------
// createJobOutputParser
// ---------------------------------------------------------------------------

test("createJobOutputParser reads GACDL percentage lines", () => {
  const seen = [];
  const parse = createJobOutputParser({ onProgress: (p) => seen.push(p) });

  parse(Buffer.from("GACDL   4"));
  parse(Buffer.from("5.6%\nGACDL 100.0%\nGACDL  78.9%\n"));

  assert.deepEqual(seen, [45.6, 78.9]);
});

test("createJobOutputParser ignores the manifest 100% line and reports phases", () => {
  const progress = [];
  const details = [];
  const parse = createJobOutputParser({
    onProgress: (p) => progress.push(p),
    onDetail: (d) => details.push(d),
  });

  parse(Buffer.from("GACDL 100.0%\n[FixupM3u8] Fixing MPEG-TS in MP4 container\n[ExtractAudio] Destination: audio.m4a\n"));

  assert.deepEqual(progress, []);
  assert.deepEqual(details, ["Finalizing MP4 container…", "Extracting audio…"]);
});

// ---------------------------------------------------------------------------
// process plumbing (no network): killProcessTree should be a no-op on dead procs
// ---------------------------------------------------------------------------

test("classifyYtDlpError handles timeouts", () => {
  const r = classifyYtDlpError("", "TIMEOUT");
  assert.equal(r.status, 504);
});

// ---------------------------------------------------------------------------
// Fallback attempts (buildVideoAttempts / buildAudioAttempts)
// ---------------------------------------------------------------------------

test("buildVideoFormats attaches ordered fallback selectors to every plan", () => {
  const [plan] = buildVideoFormats([dashVideo240, dashAudio140]);
  assert.deepEqual(plan.selectors, [
    "133+140",
    "133+bestaudio[ext=m4a]/133+bestaudio",
    "best[height=240][protocol*=m3u8]",
    "best[height<=240][protocol*=m3u8]/best[height<=240]",
  ]);
});

test("buildVideoAttempts starts with the plan's preferred source and retries it", () => {
  const [plan] = buildVideoFormats([dashVideo240, dashAudio140]);
  const attempts = buildVideoAttempts({ plan, height: 240 });

  assert.equal(attempts[0].selector, "133+140");
  assert.equal(attempts[1].selector, "133+140", "second attempt retries the preferred source");
  assert.ok(attempts[1].delayMs > 0, "retry waits briefly before re-extracting");
  assert.ok(attempts.length <= 7);
  assert.ok(attempts.every((a) => typeof a.selector === "string" && a.selector.length > 0));
});

test("buildVideoAttempts ends with alternate YouTube player clients", () => {
  const attempts = buildVideoAttempts({ height: 720 });
  const clients = attempts.flatMap((a) => a.extractorArgs || []);
  assert.ok(clients.some((c) => c.includes("web_safari")));
  assert.ok(clients.some((c) => c.includes("player_client=tv")));
});

test("buildVideoAttempts supports the legacy raw formatId selection", () => {
  const attempts = buildVideoAttempts({ formatId: "137", height: 1080 });
  assert.match(attempts[0].selector, /^137\+/);
});

test("merge plans expose separate video/audio estimates and parallel-download attempts", () => {
  const [plan] = buildVideoFormats([dashVideo240, dashAudio140], 100);
  assert.equal(plan.videoSize, 2500000);
  assert.equal(plan.audioSize, 1600000);
  assert.equal(plan.estimatedSize, plan.videoSize + plan.audioSize);

  const attempts = buildVideoAttempts({ plan, height: 240 });
  assert.deepEqual(attempts[0].merge, { videoSelector: "133", audioSelector: "140" });
  assert.deepEqual(attempts[1].merge, attempts[0].merge, "the fresh retry keeps the merge plan");

  const audioFallback = attempts.find((a) => a.merge && a.merge.audioSelector.includes("bestaudio"));
  assert.ok(audioFallback, "expected an audio-fallback merge attempt");
  assert.equal(audioFallback.merge.videoSelector, "133");

  // Muxed/progressive attempts must stay single-process downloads.
  const muxedAttempts = buildVideoAttempts({ plan: buildVideoFormats([hls93])[0], height: 360 });
  assert.equal(muxedAttempts[0].merge, undefined);
});

test("buildAudioAttempts tries the preferred source, then audio-only and player fallbacks", () => {
  const attempts = buildAudioAttempts({ sourceFormatId: "93" });
  assert.match(attempts[0].selector, /^93\//);
  assert.equal(attempts[1].selector, attempts[0].selector);
  assert.ok(attempts.some((a) => a.selector.startsWith("bestaudio")));
  assert.ok(attempts.some((a) => (a.extractorArgs || []).some((c) => c.includes("web_safari"))));
});

test("buildAudioAttempts works without a detected source", () => {
  const attempts = buildAudioAttempts({});
  assert.ok(attempts.length >= 3);
  assert.ok(attempts[0].selector.includes("bestaudio"));
});

// ---------------------------------------------------------------------------
// isFatalDownloadError
// ---------------------------------------------------------------------------

test("isFatalDownloadError marks unavailable/private videos as fatal but not 403s", () => {
  assert.equal(isFatalDownloadError("ERROR: Video unavailable"), true);
  assert.equal(isFatalDownloadError("ERROR: Private video. Sign in if you've been granted access"), true);
  assert.equal(isFatalDownloadError("ERROR: Sign in to confirm your age"), true);

  // Blocked media URLs and missing formats must stay retryable.
  assert.equal(isFatalDownloadError("ERROR: unable to download video data: HTTP Error 403: Forbidden"), false);
  assert.equal(isFatalDownloadError("ERROR: Requested format is not available"), false);
  assert.equal(isFatalDownloadError(""), false);
});

test("startVideoDownload refuses missing selectors", () => {
  assert.throws(
    () => startVideoDownload("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {}),
    /selector/i
  );
});

// ---------------------------------------------------------------------------
// runMediaJob (fake processes, no network)
// ---------------------------------------------------------------------------

function makeFakeJob({ code, stderr = "", produce = null, delay = 10 } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gac-fake-"));
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 0;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };

  setTimeout(() => {
    if (stderr) proc.stderr.write(stderr);
    if (produce) fs.writeFileSync(path.join(tmpDir, produce), "media-bytes");
    proc.stdout.end();
    proc.stderr.end();
    proc.emit("close", code);
  }, delay);

  return { proc, tmpDir, preferredExts: ["mp4"] };
}

test("runMediaJob retries the next attempt after a non-fatal failure", async () => {
  const attempts = [
    { selector: "first", note: "first" },
    { selector: "second", note: "second" },
  ];
  let calls = 0;

  const result = await runMediaJob({
    attempts,
    startJob: () => {
      calls += 1;
      if (calls === 1) {
        return makeFakeJob({ code: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" });
      }
      return makeFakeJob({ code: 0, produce: "media.mp4" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptsUsed, 2);
  assert.equal(calls, 2);
  assert.ok(result.output.path.endsWith("media.mp4"));
  cleanupJobDir(result.job.tmpDir);
});

test("runMediaJob stops immediately on fatal errors and keeps the 403 details for classification", async () => {
  let calls = 0;
  const fatal = await runMediaJob({
    attempts: [{ selector: "a" }, { selector: "b" }],
    startJob: () => {
      calls += 1;
      return makeFakeJob({ code: 1, stderr: "ERROR: Video unavailable" });
    },
  });
  assert.equal(fatal.ok, false);
  assert.equal(fatal.fatal, true);
  assert.equal(calls, 1, "fatal errors must not burn the remaining attempts");

  const blocked = await runMediaJob({
    attempts: [{ selector: "a" }],
    startJob: () => makeFakeJob({ code: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(classifyYtDlpError(blocked.stderr, blocked.code).status, 502);
});

test("runMediaJob reports abort when the signal fires", async () => {
  const controller = new AbortController();
  const promise = runMediaJob({
    attempts: [{ selector: "a" }, { selector: "b" }],
    startJob: () => makeFakeJob({ code: 0, produce: "media.mp4", delay: 50 }),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 10);
  const result = await promise;
  assert.equal(result.aborted, true);
});

test("runMediaJob reports failure when every attempt runs out", async () => {
  let calls = 0;
  const result = await runMediaJob({
    attempts: [{ selector: "a" }, { selector: "b" }],
    startJob: () => {
      calls += 1;
      return makeFakeJob({ code: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  assert.match(String(result.stderr), /403/);
});
