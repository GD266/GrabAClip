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
 */
function execYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
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
        proc.kill("SIGKILL");
        reject(new Error("yt-dlp output too large"));
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      // yt-dlp binary not found
      if (err.code === "ENOENT") {
        err.message = "yt-dlp binary not found. Please ensure yt-dlp is installed and in PATH.";
        err.status = 500;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
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

  // Group by height, keep best per height (prefer mp4 + has audio, then higher fps/bitrate)
  // For reliability, prefer m3u8 (HLS) over https DASH for now due to YouTube SABR 403 issues on DASH
  const byHeight = new Map();

  for (const f of videoFormats) {
    const height = f.height || 0;
    if (!height) continue; // skip audio-only or unknown

    const key = height; // deduplicate by exact height

    const existing = byHeight.get(key);
    // Scoring: prefer m3u8 (HLS) for reliability, then mp4, has audio, higher fps, higher tbr
    const score = (fmt) => {
      let s = 0;
      const proto = (fmt.protocol || fmt.proto || "").toLowerCase();
      if (proto.includes("m3u8")) s += 5000; // strongly prefer HLS (reliable)
      if (fmt.ext === "mp4") s += 1000;
      if (fmt.acodec && fmt.acodec !== "none") s += 500;
      if (fmt.fps) s += fmt.fps;
      if (fmt.tbr) s += fmt.tbr / 100;
      // Also prefer formats where protocol is http(s) but not dash video-only that requires ffmpeg merging?
      // HLS pre-merged already good.
      return s;
    };

    if (!existing || score(f) > score(existing)) {
      byHeight.set(key, f);
    }
  }

  // Convert to sorted array descending by height
  const deduped = Array.from(byHeight.values()).sort((a, b) => b.height - a.height);

  // Map to simplified format objects
  return deduped.map((f) => ({
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
    // human label like "1080p" or "720p60"
    label: f.height ? `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""}` : f.format_id,
    // display label includes ext and audio indicator
    displayLabel: `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""} - ${f.ext} ${f.acodec && f.acodec !== "none" ? "" : "(video only, audio will be merged)"}`.trim(),
  }));
}

export async function getVideoInfo(rawUrl) {
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
    result = await execYtDlp(args, INFO_TIMEOUT_MS);
  } catch (e) {
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
 * Helper to get sanitized title for filename (quick info fetch)
 * Uses getVideoInfo internally but with lighter parsing
 */
export async function getTitleForFilename(rawUrl) {
  const info = await getVideoInfo(rawUrl);
  return info.title;
}
