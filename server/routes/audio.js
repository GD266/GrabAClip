import { Router } from "express";
import fs from "node:fs";
import { sanitizeFilename, sanitizeAsciiFilename, isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";
import {
  startAudioDownload,
  getVideoInfo,
  classifyYtDlpError,
  createJobOutputParser,
  findOutputFile,
  cleanupJobDir,
  killProcessTree,
  MIME_BY_EXT,
  AUDIO_FORMAT_IDS,
  AUDIO_MP3_QUALITIES,
} from "../services/ytdlp.js";
import { startDownload, setPhase, setProgressDetail, completeDownload, failDownload, isActive, removeDownload } from "../utils/downloadStatus.js";

const router = Router();

// GET /api/download/audio?url=...&format=m4a|mp3|wav|opus&quality=320
router.get("/", async (req, res) => {
  const url = req.query.url;
  const formatParam = req.query.format || req.query.formatId || "m4a";

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "YouTube URL is required." });
  }
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: "Invalid YouTube URL." });
  }

  const normalizedUrl = normalizeYouTubeUrl(url);
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

  // Prevent duplicate active audio downloads for the same video
  if (isActive("audio", normalizedUrl)) {
    return res.status(429).json({ error: "An audio download for this video is already in progress. Please wait or refresh the page." });
  }

  startDownload("audio", normalizedUrl);

  let title = "audio";
  let info = null;
  const abortController = new AbortController();
  let clientGone = false;
  const onClientAbortInfo = () => {
    clientGone = true;
    try { abortController.abort(); } catch {}
  };
  req.on("close", onClientAbortInfo);
  req.on("aborted", onClientAbortInfo);

  setPhase("audio", normalizedUrl, "fetching");
  try {
    info = await getVideoInfo(normalizedUrl, { signal: abortController.signal });
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

  setPhase("audio", normalizedUrl, "processing");
  setProgressDetail("audio", normalizedUrl, 0, "Starting download…");

  let job;
  try {
    job = startAudioDownload(normalizedUrl, { format, quality, sourceFormatId });
  } catch (e) {
    console.error("[audio] failed to start job:", e.message);
    failDownload("audio", normalizedUrl, e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }

  const { proc: downloadProc, tmpDir } = job;
  let stderr = "";
  let fileStream = null;
  let finished = false;
  let jobCleaned = false;

  const finishCleanup = () => {
    if (jobCleaned) return;
    jobCleaned = true;
    cleanupJobDir(tmpDir);
  };

  const onClientGone = () => {
    if (finished || clientGone) return;
    clientGone = true;
    killProcessTree(downloadProc);
    if (fileStream) fileStream.destroy();
    else finishCleanup();
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

  const parseProgress = createJobOutputParser({
    onProgress: (pct) => setProgressDetail("audio", normalizedUrl, pct, `Downloading from YouTube… ${Math.round(pct)}%`),
    onDetail: (text) => setProgressDetail("audio", normalizedUrl, null, text),
  });
  downloadProc.stdout.on("data", parseProgress);

  downloadProc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  downloadProc.stderr.on("error", (err) => console.error("[audio] stderr error", err.message));
  downloadProc.stdout.on("error", (err) => console.error("[audio] stdout error", err.message));

  downloadProc.on("error", (err) => {
    console.error("[audio] process error:", err.message);
    failDownload("audio", normalizedUrl, err.message);
    finishCleanup();
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ error: "Audio download failed due to server error." });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  downloadProc.on("close", (code) => {
    if (clientGone) {
      finishCleanup();
      return;
    }

    if (code !== 0) {
      console.error(`[audio] yt-dlp exited ${code}:`, stderr.slice(0, 500));
      const classified = classifyYtDlpError(stderr, code);
      failDownload("audio", normalizedUrl, classified.message);
      finishCleanup();
      if (!res.headersSent && !res.writableEnded) {
        res.status(classified.status).json({ error: classified.message, details: stderr.slice(0, 300) });
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const output = findOutputFile(tmpDir, job.preferredExts);
    if (!output) {
      console.error(`[audio] yt-dlp finished but no audio file found:`, stderr.slice(0, 500));
      const message = "Audio download produced no file. Please try another format.";
      failDownload("audio", normalizedUrl, message);
      finishCleanup();
      if (!res.headersSent && !res.writableEnded) {
        res.status(502).json({ error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const ext = output.ext || job.outputExt || "m4a";
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
});

export default router;
