import { spawn } from "node:child_process";
import { isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TIMEOUT_MS = 30000; // 30s
const DOWNLOAD_TIMEOUT_MS = 300000; // 5min

function classifyYtDlpError(stderr, code) {
  const lower = (stderr || "").toLowerCase();

  if (lower.includes("video unavailable") || lower.includes("this video is unavailable")) {
    return { status: 404, message: "Video unavailable. The video may have been removed or is not accessible." };
  }
  if (lower.includes("private video")) {
    return { status: 403, message: "This video is private and cannot be downloaded." };
  }
  // Age-restricted / authentication required — must be checked before generic 403
  // Covers yt-dlp messages: "Sign in to confirm your age", "age-restricted", "inappropriate for some users", etc.
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
  if (lower.includes("unsupported url")) {
    return { status: 400, message: "Unsupported URL. Please provide a valid YouTube video URL." };
  }
  if (lower.includes("unable to extract") || lower.includes("extraction failed")) {
    return { status: 502, message: "Failed to extract video information. YouTube may have changed its format or the video is restricted." };
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
 * Execute yt-dlp and capture stdout as JSON/ string, with timeout.
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
  // Prefer highest resolution
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0));
  return sorted[0]?.url || null;
}

function buildFormats(rawFormats) {
  if (!Array.isArray(rawFormats)) return [];

  // Filter to formats that have video codec != none, and exclude storyboard, mhtml
  const videoFormats = rawFormats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.format_id && f.ext && !f.format_note?.includes("storyboard")
  );

  // Phase 4: Present sensible options rather than raw IDs
  // - 360p, 480p, 720p, 1080p always (if available)
  // - Higher resolutions only when reliably available (HLS/m3u8, not SABR-prone DASH)
  const STANDARD_HEIGHTS = new Set([360, 480, 720, 1080]);
  const byHeight = new Map();

  for (const f of videoFormats) {
    const height = f.height || 0;
    if (!height) continue;
    // Only consider standard heights + higher if reliable
    const proto = (f.protocol || f.proto || "").toLowerCase();
    const isHls = proto.includes("m3u8");
    // For standard heights, allow any protocol (HLS preferred via scoring)
    // For higher >1080, only keep if HLS (reliably available)
    if (height > 1080 && !isHls) {
      continue;
    }
    // Also skip very low preview heights (<144) and storyboard
    if (height < 144) continue;

    const key = height;
    const existing = byHeight.get(key);
    const score = (fmt) => {
      let s = 0;
      const p = (fmt.protocol || fmt.proto || "").toLowerCase();
      if (p.includes("m3u8")) s += 5000; // HLS reliable
      if (fmt.ext === "mp4") s += 1000;
      if (fmt.acodec && fmt.acodec !== "none") s += 500;
      if (fmt.fps) s += fmt.fps;
      if (fmt.tbr) s += fmt.tbr / 100;
      return s;
    };
    if (!existing || score(f) > score(existing)) {
      byHeight.set(key, f);
    }
  }

  // Only keep sensible heights, sorted desc, limit to available
  const allowedHeights = [1080, 720, 480, 360, 240, 144];
  // If higher HLS existed (e.g., 1440 HLS), include it, but filter above ensures only reliable
  // Build list: include 360/480/720/1080 if present, plus any higher HLS that passed filter
  let deduped = Array.from(byHeight.values()).sort((a, b) => b.height - a.height);
  // Filter to only show sensible options that are actually available
  // Keep up to 4-5 options max, preferring standard heights
  const standard = deduped.filter((f) => STANDARD_HEIGHTS.has(f.height));
  const higher = deduped.filter((f) => f.height > 1080);
  const lower = deduped.filter((f) => f.height < 360 && !STANDARD_HEIGHTS.has(f.height));
  // Combine: higher (if any reliable) + standard + lower fallback if needed
  let sensible = [...higher, ...standard];
  // If no standard found (edge), fallback to lower
  if (sensible.length === 0) sensible = deduped.slice(0, 4);
  // Ensure we have at least 360 if available, but not duplicates
  // Already handled

  // If sensible still empty, use deduped
  if (sensible.length === 0) sensible = deduped;

  // Sort again desc
  sensible.sort((a, b) => b.height - a.height);

  return sensible.map((f) => ({
    formatId: f.format_id,
    ext: f.ext,
    height: f.height,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec,
    acodec: f.acodec || "none",
    protocol: f.protocol || f.proto || null,
    hasAudio: !!(f.acodec && f.acodec !== "none"),
    filesize: f.filesize || f.filesize_approx || null,
    tbr: f.tbr || null,
    formatNote: f.format_note || null,
    label: f.height ? `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""}` : f.format_id,
    displayLabel: `${f.height}p`,
  }));
}

export function buildAudioFormats(rawFormats) {
  if (!Array.isArray(rawFormats)) return [];

  const audioOnly = rawFormats.filter(
    (f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none" && f.format_id && f.ext
  );
  if (audioOnly.length === 0) return [];

  const bestOverall = [...audioOnly].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const bestM4a = [...audioOnly]
    .filter((f) => f.ext === "m4a")
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const bestOpus = [...audioOnly]
    .filter((f) => f.ext === "webm" || f.acodec?.toLowerCase().includes("opus"))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  // Phase 4: Small user-friendly selection — Best, High quality, MP3
  const normalized = [];

  // Best — highest quality native
  if (bestOverall) {
    const isHigh = bestOverall.ext === "m4a" && Math.round(bestOverall.abr || 0) >= 120;
    normalized.push({
      id: "best",
      formatId: bestOverall.format_id,
      ext: bestOverall.ext,
      acodec: bestOverall.acodec,
      abr: bestOverall.abr || bestOverall.tbr || null,
      filesize: bestOverall.filesize || bestOverall.filesize_approx || null,
      label: "Best",
      displayLabel: `Best — ${bestOverall.ext.toUpperCase()} ${Math.round(bestOverall.abr || bestOverall.tbr || 0)}k`,
      isConversion: false,
    });
  }

  // High quality — best M4A/AAC where available, distinct from Best
  if (bestM4a && bestM4a.format_id !== bestOverall?.format_id) {
    normalized.push({
      id: "high",
      formatId: bestM4a.format_id,
      ext: "m4a",
      acodec: bestM4a.acodec,
      abr: bestM4a.abr || bestM4a.tbr || null,
      filesize: bestM4a.filesize || bestM4a.filesize_approx || null,
      label: "High",
      displayLabel: `High — M4A ${Math.round(bestM4a.abr || bestM4a.tbr || 0)}k`,
      isConversion: false,
    });
  } else if (bestM4a && normalized.length === 0) {
    normalized.push({
      id: "high",
      formatId: bestM4a.format_id,
      ext: "m4a",
      acodec: bestM4a.acodec,
      abr: bestM4a.abr || bestM4a.tbr || null,
      filesize: bestM4a.filesize || bestM4a.filesize_approx || null,
      label: "High",
      displayLabel: `High — M4A ${Math.round(bestM4a.abr || bestM4a.tbr || 0)}k`,
      isConversion: false,
    });
  } else if (!bestM4a && bestOpus) {
    // Fallback high quality if no M4A: best opus/webm
    if (bestOpus.format_id !== bestOverall?.format_id) {
      normalized.push({
        id: "high",
        formatId: bestOpus.format_id,
        ext: bestOpus.ext,
        acodec: bestOpus.acodec,
        abr: bestOpus.abr || bestOpus.tbr || null,
        filesize: bestOpus.filesize || bestOpus.filesize_approx || null,
        label: "High",
        displayLabel: `High — ${bestOpus.ext.toUpperCase()} ${Math.round(bestOpus.abr || bestOpus.tbr || 0)}k`,
        isConversion: false,
      });
    }
  }

  // MP3 where supported — always via conversion, small selection
  normalized.push({
    id: "mp3",
    formatId: "mp3",
    ext: "mp3",
    acodec: "mp3",
    abr: 192,
    filesize: null,
    label: "MP3",
    displayLabel: "MP3 — Converted 192k",
    isConversion: true,
  });

  // Ensure uniqueness by id, limit to 3
  const seen = new Set();
  const deduped = normalized.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return deduped.slice(0, 3);
}

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
    "--no-playlist",
    "--remote-components",
    "ejs:github",
    "--dump-json",
    "--no-warnings",
    "--no-progress",
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

  // Check if it's actually a video (not playlist)
  if (data._type === "playlist") {
    const err = new Error("Playlists are not supported. Please provide a single video URL.");
    err.status = 400;
    throw err;
  }

  // Extract fields - required + optional (do not fail if optional missing)
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
  // upload_date is YYYYMMDD from yt-dlp, convert to YYYY-MM-DD if valid
  let uploadDate = null;
  let uploadDateFormatted = null;
  if (data.upload_date && /^\d{8}$/.test(String(data.upload_date))) {
    const s = String(data.upload_date);
    uploadDate = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    uploadDateFormatted = uploadDate;
  } else if (data.upload_date) {
    uploadDate = String(data.upload_date);
    uploadDateFormatted = uploadDate;
  } else if (data.release_date) {
    uploadDate = String(data.release_date);
  }

  // Build formats
  const formats = buildFormats(data.formats);
  const audioFormats = buildAudioFormats(data.formats);

  if (formats.length === 0) {
    // Fallback: at least offer some common qualities if raw formats empty but we have height?
    // Could still fail
  }

  return {
    videoId,
    title,
    channel,
    uploader,
    channelId,
    duration, // seconds
    durationFormatted: formatDuration(duration),
    thumbnail,
    description,
    viewCount,
    likeCount,
    uploadDate,
    uploadDateFormatted,
    formats,
    audioFormats,
    // extra for debugging but not exposed? keep internal
    _rawTitle: title,
    _rawData: {
      // keep minimal raw for intelligence fallback
      tags: data.tags || null,
      categories: data.categories || null,
    },
  };
}

/**
 * Create a download stream process.
 * Returns child_process handle. Caller is responsible for piping and cleanup.
 * formatSelector: yt-dlp -f argument
 */
export function createDownloadStream(rawUrl, options = {}) {
  const { formatId = null, isHeight = false } = options;

  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL");
    err.status = 400;
    throw err;
  }
  const url = normalizeYouTubeUrl(rawUrl);

  let formatSelector;
  if (!formatId) {
    formatSelector = "bestvideo+bestaudio/best";
  } else if (isHeight) {
    const h = String(formatId).replace("p", "");
    // Prefer mp4 where possible
    formatSelector = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  } else {
    // specific format id - try to merge audio if needed
    // sanitize already validated formatId
    formatSelector = `${formatId}+bestaudio/${formatId}/best`;
  }

  const args = [
    "--no-playlist",
    "--remote-components",
    "ejs:github",
    "-f",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--no-warnings",
    "--no-progress",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "-o",
    "-", // stdout
    url,
  ];

  // Use spawn without shell
  const proc = spawn(YTDLP_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // Set timeout for whole download (will be killed externally if needed)
  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, DOWNLOAD_TIMEOUT_MS);

  // Cleanup timeout on exit
  proc.on("close", () => clearTimeout(timeout));
  proc.on("error", () => clearTimeout(timeout));

  return proc;
}

/**
 * Create audio download stream
 * Supports: best (native), m4a (native), mp3 (via ffmpeg conversion)
 * Returns object { ytdlpProc, ffmpegProc, stream, cleanup, isConversion }
 */
export function createAudioDownloadStream(rawUrl, options = {}) {
  const { format = "best" } = options; // mp3, m4a, best

  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL");
    err.status = 400;
    throw err;
  }
  const url = normalizeYouTubeUrl(rawUrl);

  const normalizedFormat = String(format).toLowerCase().trim();
  const allowed = new Set(["best", "mp3", "m4a", "aac", "opus", "wav"]);
  if (!allowed.has(normalizedFormat)) {
    const err = new Error(`Unsupported audio format "${format}". Supported: mp3, m4a, best`);
    err.status = 400;
    throw err;
  }

  // Determine yt-dlp format selector and output handling
  // For audio, direct bestaudio often fails with SABR 403 (https DASH). Use HLS video (91-96) as reliable source and extract audio via ffmpeg.
  // This preserves the HLS fallback used for video and avoids unnecessary re-encode when possible.
  let ytdlpFormat;
  let needsConversion = false;
  let outputExt = normalizedFormat;
  let ffmpegArgs = null;

  // HLS video source: try smallest HLS first (91) then larger, fallback to best
  const hlsFallback = "91/92/93/94/95/96/best";

  if (normalizedFormat === "mp3") {
    // Use HLS video -> transcode to mp3 192k
    ytdlpFormat = hlsFallback;
    needsConversion = true;
    outputExt = "mp3";
    ffmpegArgs = [
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-f", "mp3",
      "pipe:1",
    ];
  } else if (normalizedFormat === "m4a" || normalizedFormat === "aac" || normalizedFormat === "high") {
    // Use HLS video -> extract aac to m4a (fragmented mp4, no re-encode where possible)
    ytdlpFormat = hlsFallback;
    outputExt = "m4a";
    needsConversion = true;
    ffmpegArgs = [
      "-i", "pipe:0",
      "-vn",
      "-c:a", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov",
      "pipe:1",
    ];
    // Fallback to re-encode if copy fails: ffmpeg will handle, but we use copy for efficiency
  } else if (normalizedFormat === "opus") {
    ytdlpFormat = "bestaudio[ext=webm]/bestaudio";
    outputExt = "webm";
    needsConversion = false;
  } else {
    // best - use HLS video and extract best available audio without re-encode if possible
    // For best, we can offer m4a via copy from HLS (most compatible)
    ytdlpFormat = hlsFallback;
    outputExt = "m4a";
    needsConversion = true;
    ffmpegArgs = [
      "-i", "pipe:0",
      "-vn",
      "-c:a", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov",
      "pipe:1",
    ];
  }

  const ytdlpArgs = [
    "--no-playlist",
    "--remote-components",
    "ejs:github",
    "-f",
    ytdlpFormat,
    "--no-warnings",
    "--no-progress",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "-o",
    "-",
    url,
  ];

  // For native m4a/best, we can try to keep original but if best is webm, we still stream webm
  // No ffmpeg needed, just yt-dlp stdout

  const ytdlpProc = spawn(YTDLP_BIN, ytdlpArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let ffmpegProc = null;
  let stream = ytdlpProc.stdout;

  if (needsConversion) {
    // Spawn ffmpeg to convert pipe:0 -> mp3 pipe:1
    const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
    ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Pipe yt-dlp stdout to ffmpeg stdin
    ytdlpProc.stdout.pipe(ffmpegProc.stdin);

    // Handle ffmpeg errors: if ffmpeg fails, kill ytdlp
    ffmpegProc.on("error", (err) => {
      ytdlpProc.kill("SIGKILL");
    });
    ytdlpProc.on("error", () => {
      try { ffmpegProc.kill("SIGKILL"); } catch {}
    });

    stream = ffmpegProc.stdout;

    // Timeout for whole pipeline
    const timeout = setTimeout(() => {
      try { ytdlpProc.kill("SIGKILL"); } catch {}
      try { ffmpegProc.kill("SIGKILL"); } catch {}
    }, DOWNLOAD_TIMEOUT_MS);

    const clear = () => clearTimeout(timeout);
    ytdlpProc.on("close", clear);
    ffmpegProc.on("close", clear);
    ffmpegProc.on("error", clear);
    ytdlpProc.on("error", clear);

    return { ytdlpProc, ffmpegProc, stream, isConversion: true, outputExt };
  }

  // Native - timeout handling
  const timeout = setTimeout(() => {
    try { ytdlpProc.kill("SIGKILL"); } catch {}
  }, DOWNLOAD_TIMEOUT_MS);
  ytdlpProc.on("close", () => clearTimeout(timeout));
  ytdlpProc.on("error", () => clearTimeout(timeout));

  return { ytdlpProc, ffmpegProc: null, stream, isConversion: false, outputExt };
}

/**
 * Helper to get sanitized title for filename (quick info fetch)
 * Uses getVideoInfo internally but with lighter parsing
 */
export async function getTitleForFilename(rawUrl) {
  const info = await getVideoInfo(rawUrl);
  return info.title;
}
