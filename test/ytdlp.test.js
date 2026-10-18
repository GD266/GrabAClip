import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVideoFormats,
  buildAudioFormats,
  pickAudioSource,
  classifyYtDlpError,
  createJobOutputParser,
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
