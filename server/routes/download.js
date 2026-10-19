import { Router } from "express";
import fs from "node:fs";
import { validateDownloadQuery, sanitizeFilename, sanitizeAsciiFilename } from "../utils/validation.js";
import {
  startVideoDownload,
  startMergeDownload,
  getVideoInfo,
  classifyYtDlpError,
  buildVideoAttempts,
  runMediaJob,
  cleanupJobDir,
  MIME_BY_EXT,
} from "../services/ytdlp.js";
import { getVideoInfoCached } from "../utils/infoCache.js";
import { startDownload, setPhase, setProgressDetail, completeDownload, failDownload, isActive, removeDownload } from "../utils/downloadStatus.js";

const router = Router();

// GET /api/download?url=...&height=720 (or legacy formatId=...)
router.get("/", async (req, res) => {
  const validation = validateDownloadQuery(req.query);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { normalizedUrl, height, formatId } = validation;

  // Prevent duplicate active downloads for same video
  if (isActive("video", normalizedUrl)) {
    return res.status(429).json({ error: "A download for this video is already in progress. Please wait or refresh the page." });
  }

  startDownload("video", normalizedUrl);

  // Info is almost always already in the cache (the UI fetched /api/info a
  // moment ago), so the job starts immediately instead of running an extra
  // yt-dlp extraction round trip.
  let title = "video";
  const infoController = new AbortController();
  let clientGone = false;
  const onClientAbortInfo = () => {
    clientGone = true;
    try { infoController.abort(); } catch {}
  };
  req.on("close", onClientAbortInfo);
  req.on("aborted", onClientAbortInfo);

  setPhase("video", normalizedUrl, "fetching");
  let info;
  try {
    info = await getVideoInfoCached(normalizedUrl, () => getVideoInfo(normalizedUrl, { signal: infoController.signal }));
    if (clientGone) {
      removeDownload("video", normalizedUrl);
      return;
    }
    title = info.title;
  } catch (e) {
    if (e.code === "ABORTED" || e.status === 499 || clientGone) {
      removeDownload("video", normalizedUrl);
      return;
    }
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";
    console.error(`[download] info fetch failed for ${normalizedUrl}:`, e.original || e.message);
    failDownload("video", normalizedUrl, message);
    return res.status(status).json({ error: message });
  } finally {
    try { req.off("close", onClientAbortInfo); req.off("aborted", onClientAbortInfo); } catch {}
  }

  if (clientGone || req.destroyed || res.writableEnded) {
    removeDownload("video", normalizedUrl);
    return;
  }

  // Resolve what to download:
  //  - explicit height -> matching plan from the info response
  //  - no selection    -> best available plan (<= 1080p)
  //  - legacy formatId -> raw yt-dlp selection
  let plan = null;
  if (height != null) {
    plan = info.formats.find((f) => f.height === height) || null;
    if (!plan) {
      const available = info.formats.map((f) => f.label).join(", ") || "none";
      const message = `${height}p is not available for this video. Available qualities: ${available}.`;
      failDownload("video", normalizedUrl, message);
      return res.status(400).json({ error: message });
    }
  } else if (!formatId) {
    plan = info.formats[0] || null;
  }

  // Ordered fallback chain: preferred source -> fresh retry -> safer
  // selectors -> alternate YouTube player clients.
  const attempts = buildVideoAttempts({ plan, height, formatId });

  setPhase("video", normalizedUrl, "processing");
  setProgressDetail("video", normalizedUrl, 0, attempts[0]?.note || "Starting download…");

  const jobController = new AbortController();
  let fileStream = null;
  let finished = false;
  let jobCleaned = false;

  const onClientGone = () => {
    if (finished || clientGone) return;
    clientGone = true;
    jobController.abort();
    if (fileStream) fileStream.destroy();
    removeDownload("video", normalizedUrl);
    console.log(`[download] client disconnected; job cancelled for ${normalizedUrl}`);
  };

  req.on("close", onClientGone);
  req.on("aborted", onClientGone);
  req.on("error", onClientGone);
  res.on("close", onClientGone);
  res.on("error", onClientGone);
  res.on("finish", () => {
    finished = true;
    completeDownload("video", normalizedUrl);
    console.log(`[download] delivered ${normalizedUrl} height=${height || "auto"}`);
  });

  if (req.destroyed || res.writableEnded) {
    onClientGone();
    return;
  }

  const result = await runMediaJob({
    attempts,
    startJob: (attempt) => {
      // Merge plans download video and audio concurrently (much faster on
      // throttled connections) and mux them locally; everything else is a
      // regular single yt-dlp job.
      if (attempt.merge) {
        return startMergeDownload(normalizedUrl, {
          videoSelector: attempt.merge.videoSelector,
          audioSelector: attempt.merge.audioSelector,
          extractorArgs: attempt.extractorArgs || null,
          videoSize: plan?.videoSize,
          audioSize: plan?.audioSize,
        });
      }
      return startVideoDownload(normalizedUrl, attempt);
    },
    onProgress: (pct) => setProgressDetail("video", normalizedUrl, pct, `Downloading from YouTube… ${Math.round(pct)}%`),
    onDetail: (text) => setProgressDetail("video", normalizedUrl, null, text),
    signal: jobController.signal,
  });

  if (clientGone || result.aborted) {
    removeDownload("video", normalizedUrl);
    return;
  }

  const finishCleanup = () => {
    if (jobCleaned) return;
    jobCleaned = true;
    if (result.job) cleanupJobDir(result.job.tmpDir);
  };

  if (!result.ok) {
    const stderr = result.stderr || "";
    console.error(`[download] all ${attempts.length} attempts failed (exit ${result.code}):`, stderr.slice(0, 500));
    const classified = classifyYtDlpError(stderr, result.code);
    failDownload("video", normalizedUrl, classified.message);
    if (!res.headersSent && !res.writableEnded) {
      res.status(classified.status).json({ error: classified.message, details: stderr.slice(0, 300) });
    } else if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  const { output, attemptsUsed } = result;
  if (attemptsUsed > 1) {
    console.log(`[download] succeeded on attempt ${attemptsUsed}/${attempts.length} for ${normalizedUrl}`);
  }

  const ext = output.ext || "mp4";
  const safeName = sanitizeFilename(title);
  const filename = `${safeName}.${ext}`;
  const encoded = encodeURIComponent(filename);
  const asciiFallback = sanitizeAsciiFilename(safeName);

  setPhase("video", normalizedUrl, "downloading");
  setProgressDetail("video", normalizedUrl, 100, "Sending file…");

  res.status(200);
  res.setHeader("Content-Type", MIME_BY_EXT[ext] || "video/mp4");
  try {
    res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}.${ext}"; filename*=UTF-8''${encoded}`);
  } catch (e) {
    console.error("[download] header set failed, using fallback", e.message);
    res.setHeader("Content-Disposition", `attachment; filename="video.${ext}"`);
  }
  res.setHeader("Content-Length", String(output.size));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");

  fileStream = fs.createReadStream(output.path);
  fileStream.on("error", (err) => {
    console.error("[download] file stream error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read the downloaded media file." });
    } else if (!res.writableEnded) {
      res.end();
    }
    finishCleanup();
  });
  fileStream.on("close", finishCleanup);
  fileStream.pipe(res);
});

export default router;
