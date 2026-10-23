import { Router } from "express";
import fs from "node:fs";
import { sanitizeFilename, sanitizeAsciiFilename, detectPlatform, normalizeMediaUrl } from "../utils/validation.js";
import {
  startAudioDownload,
  getVideoInfo,
  classifyYtDlpError,
  buildAudioAttempts,
  runMediaJob,
  cleanupJobDir,
  MIME_BY_EXT,
  AUDIO_FORMAT_IDS,
  AUDIO_MP3_QUALITIES,
} from "../services/ytdlp.js";
import { getVideoInfoCached } from "../utils/infoCache.js";
import { recordError } from "../utils/errorLog.js";
import { startDownload, setPhase, setProgressDetail, completeDownload, failDownload, isActive, removeDownload } from "../utils/downloadStatus.js";

const router = Router();

// GET /api/download/audio?url=...&format=m4a|mp3|wav|opus&quality=320
router.get("/", async (req, res) => {
  const url = req.query.url;
  const formatParam = req.query.format || req.query.formatId || "m4a";

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "A video link is required." });
  }
  const normalizedUrl = normalizeMediaUrl(url);
  if (!normalizedUrl) {
    return res.status(400).json({ error: "Unsupported link. Paste a YouTube, X, or Instagram video URL." });
  }
  const platform = detectPlatform(normalizedUrl);
  let format = String(formatParam).toLowerCase().trim();
  // Aliases from older clients.
  if (format === "best" || format === "high" || format === "aac") format = "m4a";

  if (!AUDIO_FORMAT_IDS.has(format)) {
    return res.status(400).json({ error: `Unsupported audio format "${formatParam}". Supported: m4a, mp3, wav, opus` });
  }

  let quality = null;
  if (format === "mp3") {
    const q = Number(req.query.quality ?? 192);
    if (!AUDIO_MP3_QUALITIES.has(q)) {
      return res.status(400).json({ error: `Unsupported MP3 quality "${req.query.quality}". Supported: 320, 192, 128` });
    }
    quality = q;
  }

  // Prevent duplicate active audio downloads for the same link
  if (isActive("audio", normalizedUrl)) {
    return res.status(429).json({ error: "An audio download for this link is already in progress. Please wait or refresh the page." });
  }

  startDownload("audio", normalizedUrl);

  // Cached info (the UI just fetched it) means the job starts immediately.
  let title = "audio";
  const infoController = new AbortController();
  let clientGone = false;
  const onClientAbortInfo = () => {
    clientGone = true;
    try { infoController.abort(); } catch {}
  };
  req.on("close", onClientAbortInfo);
  req.on("aborted", onClientAbortInfo);

  setPhase("audio", normalizedUrl, "fetching");
  let info;
  try {
    info = await getVideoInfoCached(normalizedUrl, () => getVideoInfo(normalizedUrl, { signal: infoController.signal }));
    if (clientGone) {
      removeDownload("audio", normalizedUrl);
      return;
    }
    title = info.title;
  } catch (e) {
    if (e.code === "ABORTED" || e.status === 499 || clientGone) {
      removeDownload("audio", normalizedUrl);
      return;
    }
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";
    console.error(`[audio] info fetch failed for ${normalizedUrl}:`, e.original || e.message);
    recordError("audio:info", e.original ? new Error(`${message} :: ${e.original}`) : e);
    failDownload("audio", normalizedUrl, message);
    return res.status(status).json({ error: message });
  } finally {
    try { req.off("close", onClientAbortInfo); req.off("aborted", onClientAbortInfo); } catch {}
  }

  if (clientGone || req.destroyed || res.writableEnded) {
    removeDownload("audio", normalizedUrl);
    return;
  }

  const sourceFormatId = info._audioSourceId || null;

  // Ordered fallback chain: preferred source -> fresh retry -> audio-only
  // fallbacks. YouTube additionally gets alternate player clients.
  const attempts = buildAudioAttempts({ sourceFormatId, platform });

  setPhase("audio", normalizedUrl, "processing");
  setProgressDetail("audio", normalizedUrl, 0, attempts[0]?.note || "Starting download…");

  const jobController = new AbortController();
  let fileStream = null;
  let finished = false;
  let jobCleaned = false;

  const onClientGone = () => {
    if (finished || clientGone) return;
    clientGone = true;
    jobController.abort();
    if (fileStream) fileStream.destroy();
    removeDownload("audio", normalizedUrl);
    console.log(`[audio] client disconnected; job cancelled for ${normalizedUrl}`);
  };

  req.on("close", onClientGone);
  req.on("aborted", onClientGone);
  req.on("error", onClientGone);
  res.on("close", onClientGone);
  res.on("error", onClientGone);
  res.on("finish", () => {
    finished = true;
    completeDownload("audio", normalizedUrl);
    console.log(`[audio] delivered ${normalizedUrl} format=${format}${quality ? ` quality=${quality}` : ""}`);
  });

  if (req.destroyed || res.writableEnded) {
    onClientGone();
    return;
  }

  const result = await runMediaJob({
    attempts,
    startJob: (attempt) => startAudioDownload(normalizedUrl, {
      ...attempt,
      format,
      quality,
      playlistItem: info._playlistItem || null,
    }),
    onProgress: (pct) => setProgressDetail("audio", normalizedUrl, pct, `Downloading audio… ${Math.round(pct)}%`),
    onDetail: (text) => setProgressDetail("audio", normalizedUrl, null, text),
    signal: jobController.signal,
  });

  if (clientGone || result.aborted) {
    removeDownload("audio", normalizedUrl);
    return;
  }

  const finishCleanup = () => {
    if (jobCleaned) return;
    jobCleaned = true;
    if (result.job) cleanupJobDir(result.job.tmpDir);
  };

  if (!result.ok) {
    const stderr = result.stderr || "";
    console.error(`[audio] all ${attempts.length} attempts failed (exit ${result.code}):`, stderr.slice(0, 500));
    const classified = classifyYtDlpError(stderr, result.code);
    recordError("audio", new Error(`${classified.message} :: ${stderr.slice(0, 400)}`));
    failDownload("audio", normalizedUrl, classified.message);
    if (!res.headersSent && !res.writableEnded) {
      res.status(classified.status).json({ error: classified.message, details: stderr.slice(0, 300) });
    } else if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  const { output, attemptsUsed } = result;
  if (attemptsUsed > 1) {
    console.log(`[audio] succeeded on attempt ${attemptsUsed}/${attempts.length} for ${normalizedUrl}`);
  }

  const ext = output.ext || result.job.outputExt || "m4a";
  const safeName = sanitizeFilename(title);
  const filename = `${safeName}.${ext}`;
  const encoded = encodeURIComponent(filename);
  const asciiFallback = sanitizeAsciiFilename(safeName);

  setPhase("audio", normalizedUrl, "downloading");
  setProgressDetail("audio", normalizedUrl, 100, "Sending file…");

  res.status(200);
  res.setHeader("Content-Type", MIME_BY_EXT[ext] || "audio/mpeg");
  try {
    res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}.${ext}"; filename*=UTF-8''${encoded}`);
  } catch (e) {
    console.error("[audio] header set failed, using fallback", e.message);
    res.setHeader("Content-Disposition", `attachment; filename="audio.${ext}"`);
  }
  res.setHeader("Content-Length", String(output.size));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");

  fileStream = fs.createReadStream(output.path);
  fileStream.on("error", (err) => {
    console.error("[audio] file stream error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read the downloaded audio file." });
    } else if (!res.writableEnded) {
      res.end();
    }
    finishCleanup();
  });
  fileStream.on("close", finishCleanup);
  fileStream.pipe(res);
});

export default router;
