import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TIMEOUT_MS = 30000; // 30s
const DOWNLOAD_TIMEOUT_MS = 1200000; // 20min (1080p HLS can be large + slow links)

// Temp workspace for media jobs. yt-dlp needs a real file so it can run its
// HLS (TS -> MP4) fixup, merge video+audio into MP4, and postprocess audio.
const TEMP_ROOT = path.join(os.tmpdir(), "grabaclip");

export const MIME_BY_EXT = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

// Shared yt-dlp flags for info/report style calls (no media transferred).
const YTDLP_QUIET_FLAGS = ["--no-playlist", "--remote-components", "ejs:github", "--no-warnings", "--no-progress"];

// Flags for media jobs: progress lines are parsed to feed the UI status.
// Note: the "download:" prefix of --progress-template is the template TYPE,
// so the printed line is "<format>" only (e.g. "GACDL  12.3%").
const YTDLP_JOB_FLAGS = [
  "--no-playlist",
  "--remote-components",
  "ejs:github",
  "--no-warnings",
  "--newline",
  "--progress-template",
  "download:GACDL %(progress._percent_str)s",
];

// Video heights the UI offers, best first.
export const VIDEO_HEIGHTS = [1080, 720, 480, 360, 240, 144];

// HLS video variants are used as the audio source (music/mp3/wav extraction).
// 93/94/95/96 carry AAC-LC 128k audio; 91/92 are HE-AAC 48k fallbacks.
const AUDIO_SOURCE_LADDER = "93/94/95/96/92/91/bestaudio[ext=m4a]/bestaudio/best";

// Audio formats always offered by the UI. mp3/wav are converted with ffmpeg.
export const AUDIO_OPTIONS = [
  { id: "m4a", quality: null, ext: "m4a", label: "M4A", displayLabel: "M4A — native AAC", note: "Original stream, no re-encode", isConversion: false },
  { id: "mp3", quality: 320, ext: "mp3", label: "MP3 320", displayLabel: "MP3 — 320 kbps", note: "Highest MP3 quality", isConversion: true },
  { id: "mp3", quality: 192, ext: "mp3", label: "MP3 192", displayLabel: "MP3 — 192 kbps", note: "Balanced quality and size", isConversion: true },
  { id: "mp3", quality: 128, ext: "mp3", label: "MP3 128", displayLabel: "MP3 — 128 kbps", note: "Smaller file", isConversion: true },
  { id: "wav", quality: null, ext: "wav", label: "WAV", displayLabel: "WAV — lossless PCM", note: "Uncompressed, very large file", isConversion: true },
];

export const AUDIO_FORMAT_IDS = new Set(["m4a", "mp3", "wav", "best", "aac", "high", "opus"]);
export const AUDIO_MP3_QUALITIES = new Set([320, 192, 128]);

export function classifyYtDlpError(stderr, code) {
  const lower = (stderr || "").toLowerCase();

  if (lower.includes("video unavailable") || lower.includes("this video is unavailable")) {
    return { status: 404, message: "Video unavailable. The video may have been removed or is not accessible." };
  }
  if (lower.includes("private video")) {
    return { status: 403, message: "This video is private and cannot be downloaded." };
  }
  // Age-restricted / authentication required — must be checked before generic 403
  if (
    lower.includes("confirm your age") ||
    lower.includes("age-restricted") ||
    lower.includes("age restricted") ||
    lower.includes("inappropriate for some users") ||
    (lower.includes("sign in") && lower.includes("age")) ||
    lower.includes("login required") ||
    lower.includes("requires authentication")
  ) {
    return { status: 403, message: "This video is age-restricted or requires sign-in." };
  }
  if (lower.includes("members-only") || lower.includes("join this channel") || lower.includes("members only")) {
    return { status: 403, message: "This video is members-only or requires purchase." };
  }
  if (lower.includes("copyright") || lower.includes("blocked")) {
    return { status: 403, message: "This video is blocked due to copyright or regional restrictions." };
  }
  if (lower.includes("live event") || lower.includes("live chat") || lower.includes("premiere will begin")) {
    return { status: 400, message: "Live streams and premieres are not supported." };
  }
  if (
    lower.includes("requested format is not available") ||
    lower.includes("requested format not available") ||
    lower.includes("format not available") ||
    lower.includes("format not found") ||
    lower.includes("no video formats found")
  ) {
    return { status: 400, message: "Requested quality is not available. Please choose another quality." };
  }
  if (lower.includes("unsupported url")) {
    return { status: 400, message: "Unsupported URL. Please provide a valid YouTube video URL." };
  }
  if (lower.includes("unable to extract") || lower.includes("extraction failed")) {
    return { status: 502, message: "Failed to extract video information. YouTube may have changed its format or the video is restricted." };
  }
  // HTTP 403 on media data: YouTube periodically blocks the media URLs of this
  // network/session. HLS variants usually keep working; retrying after a short
  // wait (or choosing another quality) is the reliable remedy.
  if (lower.includes("http error 403") || lower.includes("unable to download video data") || lower.includes("forbidden")) {
    return { status: 502, message: "YouTube temporarily blocked this download (HTTP 403). Wait a moment and try again, or pick another quality." };
  }
  if (lower.includes("network") || lower.includes("timeout") || lower.includes("http error 429")) {
    return { status: 502, message: "Network error while contacting YouTube. Please try again." };
  }
  if (code === "TIMEOUT") {
    return { status: 504, message: "Request timed out while fetching video information. Please try again." };
  }

  return { status: 500, message: "Failed to retrieve video information. Please try again." };
}

/**
 * Execute yt-dlp and capture stdout as JSON/string, with timeout.
 * Uses spawn with array args to avoid shell injection.
 * Supports AbortSignal for cancellation.
 */
function execYtDlp(args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try { proc.kill("SIGKILL"); } catch {}
      const err = new Error("Request cancelled");
      err.code = "ABORTED";
      err.status = 499;
      reject(err);
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch {}
      const err = new Error("yt-dlp timed out");
      err.code = "TIMEOUT";
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);

    const MAX_BUFFER = 10 * 1024 * 1024; // 10MB for info json

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > MAX_BUFFER) {
        clearTimeout(timeout);
        try { proc.kill("SIGKILL"); } catch {}
        reject(new Error("yt-dlp output too large"));
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (err.code === "ENOENT") {
        err.message = "yt-dlp binary not found. Please ensure yt-dlp is installed and in PATH.";
        err.status = 500;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timedOut || aborted) return;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(stderr || `yt-dlp exited with code ${code}`);
        err.code = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });
  });
}

function formatDuration(seconds) {
  if (!seconds || typeof seconds !== "number") return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0));
  return sorted[0]?.url || null;
}

// ---------------------------------------------------------------------------
// Format planning
// ---------------------------------------------------------------------------

function isHls(f) {
  return String(f.protocol || f.proto || "").toLowerCase().includes("m3u8");
}

function exactSize(f) {
  return f.filesize || f.filesize_approx || null;
}

/**
 * Estimate a format's byte size: exact when yt-dlp reported it, otherwise
 * duration * bitrate (kbps -> bytes).
 */
function estimateSize(f, duration) {
  const exact = exactSize(f);
  if (exact) return exact;
  const tbr = f.tbr || f.abr || null;
  if (tbr && duration) return Math.round(((tbr * 1000) / 8) * duration);
  return null;
}

/**
 * Codec preference for merged downloads: H.264 (avc1) plays everywhere,
 * AV1 (av01) next, then VP9. Within a codec, higher bitrate wins.
 */
function codecRank(vcodec) {
  const v = String(vcodec || "").toLowerCase();
  if (v.startsWith("avc1")) return 0;
  if (v.startsWith("av01")) return 1;
  if (v.startsWith("vp09") || v.startsWith("vp9") || v.startsWith("vp8")) return 2;
  return 3;
}

/**
 * Build the per-height download plans exposed to the UI.
 *
 * Strategy (verified against this machine's YouTube behaviour):
 *  - HLS (m3u8) streams download reliably, so a muxed HLS variant at the exact
 *    height is preferred (video + audio in one stream, no merge).
 *  - Otherwise merge a video-only DASH format with the best audio-only format.
 *  - Progressive (plain https, muxed) formats are a last resort: they are the
 *    ones most likely to return HTTP 403.
 */
export function buildVideoFormats(rawFormats, duration = null) {
  if (!Array.isArray(rawFormats)) return [];

  const usable = rawFormats.filter(
    (f) =>
      f.format_id &&
      f.ext &&
      f.ext !== "mhtml" &&
      !String(f.format_note || "").toLowerCase().includes("storyboard")
  );

  const video = usable.filter((f) => f.vcodec && f.vcodec !== "none" && f.height);
  const audioOnly = usable.filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none");

  const bestAudio =
    [...audioOnly].sort((a, b) => {
      const m4a = (x) => (x.ext === "m4a" ? 0 : 1);
      return m4a(a) - m4a(b) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
    })[0] || null;

  const hlsMuxed = video.filter((f) => isHls(f) && f.acodec && f.acodec !== "none");
  const hlsVideoOnly = video.filter((f) => isHls(f) && (!f.acodec || f.acodec === "none"));
  const dashVideoOnly = video.filter((f) => !isHls(f) && (!f.acodec || f.acodec === "none"));
  const progressive = video.filter((f) => !isHls(f) && f.acodec && f.acodec !== "none");

  const availableHeights = [...new Set(
    [...video].map((f) => f.height).filter((h) => h >= 144 && h <= 1080)
  )].sort((a, b) => b - a);

  const plans = [];
  for (const height of availableHeights) {
    let plan = null;

    const muxed = hlsMuxed
      .filter((f) => f.height === height)
      .sort((a, b) => (b.tbr || b.abr || 0) - (a.tbr || a.abr || 0))[0];
    if (muxed) {
      plan = {
        kind: "muxed",
        formatIds: [muxed.format_id],
        source: "hls",
        vcodec: muxed.vcodec,
        acodec: muxed.acodec,
        fps: muxed.fps || null,
        estimatedSize: estimateSize(muxed, duration),
      };
    }

    if (!plan) {
      const videoOnly = [...dashVideoOnly, ...hlsVideoOnly]
        .filter((f) => f.height === height)
        .sort((a, b) => codecRank(a.vcodec) - codecRank(b.vcodec) || (b.tbr || 0) - (a.tbr || 0))[0];
      if (videoOnly && bestAudio) {
        const vSize = estimateSize(videoOnly, duration);
        const aSize = estimateSize(bestAudio, duration);
        plan = {
          kind: "merge",
          formatIds: [videoOnly.format_id, bestAudio.format_id],
          source: isHls(videoOnly) ? "hls" : "dash",
          vcodec: videoOnly.vcodec,
          acodec: bestAudio.acodec || "aac",
          fps: videoOnly.fps || null,
          estimatedSize: vSize && aSize ? vSize + aSize : vSize || aSize || null,
        };
      }
    }

    if (!plan) {
      const prog = progressive
        .filter((f) => f.height === height)
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
      if (prog) {
        plan = {
          kind: "progressive",
          formatIds: [prog.format_id],
          source: "progressive",
          vcodec: prog.vcodec,
          acodec: prog.acodec || "aac",
          fps: prog.fps || null,
          estimatedSize: estimateSize(prog, duration),
        };
      }
    }

    if (!plan) continue;

    plans.push({
      height,
      label: `${height}p`,
      displayLabel: `${height}p`,
      ext: "mp4",
      hasAudio: true,
      formatId: plan.formatIds.join("+"),
      ...plan,
    });
  }

  return plans;
}

/** Always-available audio options (see AUDIO_OPTIONS). */
export function buildAudioFormats() {
  return AUDIO_OPTIONS.map((o) => ({ ...o }));
}

/**
 * Choose the yt-dlp format used as the audio source for extraction.
 * Prefers the smallest HLS variant carrying AAC-LC audio, then any HLS
 * variant, then DASH bestaudio.
 */
export function pickAudioSource(rawFormats) {
  if (!Array.isArray(rawFormats)) return null;

  const hlsAudio = rawFormats.filter(
    (f) => isHls(f) && f.acodec && f.acodec !== "none" && f.height
  );
  if (hlsAudio.length > 0) {
    const lc = hlsAudio.filter((f) => String(f.acodec).toLowerCase().startsWith("mp4a.40.2"));
    const pool = lc.length > 0 ? lc : hlsAudio;
    const chosen = [...pool].sort((a, b) => a.height - b.height || (a.tbr || 0) - (b.tbr || 0))[0];
    return {
      formatId: chosen.format_id,
      height: chosen.height,
      ext: "mp4",
      acodec: chosen.acodec,
      label: `HLS ${chosen.height}p (${lc.length > 0 ? "AAC 128k" : "HE-AAC"})`,
    };
  }

  const bestAudio = [...rawFormats]
    .filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  if (bestAudio) {
    return {
      formatId: bestAudio.format_id,
      height: null,
      ext: bestAudio.ext,
      acodec: bestAudio.acodec,
      label: `DASH audio (${Math.round(bestAudio.abr || bestAudio.tbr || 0)}k)`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

export async function getVideoInfo(rawUrl, options = {}) {
  const { signal } = options;
  if (signal?.aborted) {
    const err = new Error("Request cancelled");
    err.code = "ABORTED";
    err.status = 499;
    throw err;
  }
  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL");
    err.status = 400;
    throw err;
  }

  const url = normalizeYouTubeUrl(rawUrl);

  const args = [
    ...YTDLP_QUIET_FLAGS,
    "--dump-json",
    "--socket-timeout",
    "15",
    "--retries",
    "1",
    url,
  ];

  let result;
  try {
    result = await execYtDlp(args, INFO_TIMEOUT_MS, signal);
  } catch (e) {
    if (e.code === "ABORTED" || e.status === 499) throw e;
    if (e.status) throw e;
    const classified = classifyYtDlpError(e.stderr || e.message, e.code);
    const err = new Error(classified.message);
    err.status = classified.status;
    err.original = e.stderr || e.message;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    const err = new Error("Failed to parse video information.");
    err.status = 502;
    throw err;
  }

  if (data._type === "playlist") {
    const err = new Error("Playlists are not supported. Please provide a single video URL.");
    err.status = 400;
    throw err;
  }

  const videoId = data.id;
  const title = data.title || "Untitled";
  const channel = data.uploader || data.channel || data.uploader_id || "Unknown";
  const uploader = data.uploader || null;
  const channelId = data.channel_id || data.uploader_id || null;
  const duration = data.duration ?? null;
  const thumbnail = pickThumbnail(data.thumbnails) || data.thumbnail || null;
  const description = data.description || null;
  const viewCount = data.view_count ?? data.viewCount ?? null;
  const likeCount = data.like_count ?? data.likeCount ?? null;

  let uploadDate = null;
  let uploadDateFormatted = null;
  if (data.upload_date && /^\d{8}$/.test(String(data.upload_date))) {
    const s = String(data.upload_date);
    uploadDate = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    uploadDateFormatted = uploadDate;
  } else if (data.upload_date) {
    uploadDate = String(data.upload_date);
    uploadDateFormatted = uploadDate;
  } else if (data.release_date) {
    uploadDate = String(data.release_date);
  }

  const formats = buildVideoFormats(data.formats, duration);
  const audioFormats = buildAudioFormats();
  const audioSource = pickAudioSource(data.formats);

  return {
    videoId,
    title,
    channel,
    uploader,
    channelId,
    duration,
    durationFormatted: formatDuration(duration),
    thumbnail,
    description,
    viewCount,
    likeCount,
    uploadDate,
    uploadDateFormatted,
    formats,
    audioFormats,
    audioSource,
    // Internal: used by the audio route to pick the extraction source.
    _audioSourceId: audioSource?.formatId || null,
    _rawData: {
      tags: data.tags || null,
      categories: data.categories || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Media jobs (file based)
// ---------------------------------------------------------------------------

function makeJobDir() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEMP_ROOT, "job-"));
}

function spawnJob(args) {
  const proc = spawn(YTDLP_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const timer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch {}
  }, DOWNLOAD_TIMEOUT_MS);
  proc.on("close", () => clearTimeout(timer));
  proc.on("error", () => clearTimeout(timer));
  return proc;
}

/**
 * Parse yt-dlp stdout into progress + friendly detail callbacks.
 * Lines come from --progress-template "download:GACDL %(progress._percent_str)s"
 * and look like "GACDL  12.3%".
 */
export function createJobOutputParser({ onProgress, onDetail } = {}) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const m = line.match(/GACDL\s+([\d.]+)\s*%/);
      if (m) {
        const pct = Number(m[1]);
        // HLS manifest fetches report 100% before the media download starts.
        if (onProgress && Number.isFinite(pct) && pct < 99.9) onProgress(pct);
        continue;
      }
      if (!onDetail) continue;
      if (line.includes("[Merger]")) onDetail("Merging video and audio…");
      else if (line.includes("[FixupM3u8]")) onDetail("Finalizing MP4 container…");
      else if (line.includes("[ExtractAudio]")) onDetail("Extracting audio…");
      else if (line.includes("[Metadata]")) onDetail("Writing metadata…");
    }
  };
}

/**
 * Build the yt-dlp `-f` selector for a video download.
 * `plan` comes from buildVideoFormats(); `height` and `formatId` are legacy
 * fallbacks from the query string.
 */
function buildVideoSelector({ plan, height, formatId }) {
  const suffix = height
    ? `/best[height<=${height}][protocol*=m3u8]/best[height<=${height}]/best`
    : "/best[protocol*=m3u8]/best";

  if (plan?.formatIds?.length) {
    const [videoId, audioId] = plan.formatIds;
    if (plan.kind === "merge" && audioId) {
      return `${videoId}+${audioId}/${videoId}+bestaudio[ext=m4a]/${videoId}+bestaudio/${videoId}${suffix}`;
    }
    return `${videoId}${suffix}`;
  }

  if (formatId) {
    return `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/${formatId}${suffix}`;
  }

  // No explicit selection: best available up to 1080p, HLS first.
  return `bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][protocol*=m3u8]/best[height<=1080]/best`;
}

/**
 * Start a video download job (video + audio, merged MP4 where needed).
 * yt-dlp writes the finished file into a temp dir; the caller streams it.
 */
export function startVideoDownload(rawUrl, options = {}) {
  const { plan = null, formatId = null, height = null } = options;

  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL");
    err.status = 400;
    throw err;
  }
  const url = normalizeYouTubeUrl(rawUrl);
  const selector = buildVideoSelector({ plan, height, formatId });
  const tmpDir = makeJobDir();

  const args = [
    ...YTDLP_JOB_FLAGS,
    "-f",
    selector,
    "--merge-output-format",
    "mp4",
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    "-o",
    path.join(tmpDir, "media.%(ext)s"),
    url,
  ];

  return { proc: spawnJob(args), tmpDir, selector, preferredExts: ["mp4", "mkv", "webm"] };
}

/**
 * Start an audio-only download job.
 * yt-dlp downloads the chosen source and postprocesses with ffmpeg
 * (-x --audio-format), which produces correct containers/extradata.
 */
export function startAudioDownload(rawUrl, options = {}) {
  const { format = "m4a", quality = null, sourceFormatId = null } = options;

  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL");
    err.status = 400;
    throw err;
  }
  const url = normalizeYouTubeUrl(rawUrl);

  const requested = String(format).toLowerCase().trim();
  if (!AUDIO_FORMAT_IDS.has(requested)) {
    const err = new Error(`Unsupported audio format "${format}". Supported: m4a, mp3, wav, opus`);
    err.status = 400;
    throw err;
  }

  // Aliases from older clients.
  const audioFormat = requested === "best" || requested === "high" || requested === "aac" ? "m4a" : requested;

  let mp3Quality = null;
  if (audioFormat === "mp3") {
    const q = Number(quality ?? 192);
    if (!AUDIO_MP3_QUALITIES.has(q)) {
      const err = new Error(`Unsupported MP3 quality "${quality}". Supported: 320, 192, 128`);
      err.status = 400;
      throw err;
    }
    mp3Quality = q;
  }

  const selector = sourceFormatId ? `${sourceFormatId}/${AUDIO_SOURCE_LADDER}` : AUDIO_SOURCE_LADDER;
  const tmpDir = makeJobDir();

  const args = [
    ...YTDLP_JOB_FLAGS,
    "-f",
    selector,
    "-x",
    "--audio-format",
    audioFormat,
    "--socket-timeout",
    "20",
    "--retries",
    "3",
  ];
  if (mp3Quality) args.push("--audio-quality", `${mp3Quality}K`);
  args.push("-o", path.join(tmpDir, "audio.%(ext)s"), url);

  return { proc: spawnJob(args), tmpDir, selector, outputExt: audioFormat, preferredExts: [audioFormat] };
}

/**
 * Find the finished media file inside a job directory.
 * Ignores yt-dlp partial/downloader artifacts and returns { path, size, ext }.
 */
export function findOutputFile(tmpDir, preferredExts = []) {
  let names;
  try {
    names = fs.readdirSync(tmpDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => !/\.(part|ytdl|temp|tmp)$/i.test(n));
  if (files.length === 0) return null;

  const rank = (name) => {
    const ext = name.split(".").pop().toLowerCase();
    const i = preferredExts.indexOf(ext);
    return i === -1 ? preferredExts.length + 1 : i;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const filePath = path.join(tmpDir, files[0]);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return { path: filePath, size: stat.size, ext: files[0].split(".").pop().toLowerCase() };
  } catch {
    return null;
  }
}

/** Remove a job directory (best effort, retries while files are still open). */
export function cleanupJobDir(tmpDir) {
  if (!tmpDir) return;
  const attempt = (remaining) => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      if (remaining > 0) setTimeout(() => attempt(remaining - 1), 250);
    }
  };
  attempt(3);
}

/** Kill a spawned yt-dlp/ffmpeg process and its children. */
export function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === "win32") {
      try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
    } else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    }
  } catch {}
  try { proc.kill("SIGKILL"); } catch {}
}
