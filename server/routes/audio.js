import { Router } from "express";
import { execSync } from "node:child_process";
import { sanitizeFilename, sanitizeAsciiFilename, isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";
import { createAudioDownloadStream, getVideoInfo } from "../services/ytdlp.js";
import { startDownload, setPhase, completeDownload, failDownload, isActive, removeDownload } from "../utils/downloadStatus.js";

const router = Router();

// GET /api/download/audio?url=...&format=mp3|m4a|best
router.get("/", async (req, res) => {
  const url = req.query.url;
  const formatParam = req.query.format || req.query.formatId || "best";

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "YouTube URL is required." });
  }
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: "Invalid YouTube URL." });
  }
  const normalizedUrl = normalizeYouTubeUrl(url);
  const format = String(formatParam || "best").toLowerCase().trim();
  const normalizedFormatForCheck = format === "high" ? "m4a" : format;
  const allowed = new Set(["best", "mp3", "m4a", "aac", "high", "opus", "wav"]);
  if (!allowed.has(format)) {
    return res.status(400).json({ error: `Unsupported audio format "${formatParam}". Supported: mp3, m4a, best` });
  }

  // Prevent duplicate active audio downloads for same video + format
  if (isActive("audio", normalizedUrl)) {
    return res.status(429).json({ error: "An audio download for this video is already in progress. Please wait or refresh the page." });
  }

  const status = startDownload("audio", normalizedUrl);

  let title = "audio";
  let info = null;
  const abortController = new AbortController();
  let clientAborted = false;
  const onClientAbortInfo = () => {
    clientAborted = true;
    try { abortController.abort(); } catch {}
  };
  req.on("close", onClientAbortInfo);
  req.on("aborted", onClientAbortInfo);

  setPhase("audio", normalizedUrl, "fetching");
  try {
    info = await getVideoInfo(normalizedUrl, { signal: abortController.signal });
    if (clientAborted) {
      console.log("[audio] client aborted during info fetch");
      removeDownload("audio", normalizedUrl);
      return;
    }
    title = info.title;
  } catch (e) {
    if (e.code === "ABORTED" || e.status === 499 || clientAborted) {
      console.log("[audio] aborted during info fetch");
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
  if (clientAborted || req.destroyed || res.writableEnded) {
    console.log("[audio] client disconnected before audio download");
    removeDownload("audio", normalizedUrl);
    return;
  }

  const safeName = sanitizeFilename(title);
  const asciiFallback = sanitizeAsciiFilename(safeName);

  let outputExt = format;
  let expectedSize = null;
  if (format === "best") {
    const bestAudio = info.audioFormats?.find((a) => a.id === "best") || info.audioFormats?.[0];
    if (bestAudio) {
      outputExt = bestAudio.ext;
      if (outputExt === "webm") outputExt = "webm";
      else if (outputExt === "m4a") outputExt = "m4a";
      else outputExt = bestAudio.ext;
      if (bestAudio.filesize) expectedSize = bestAudio.filesize;
    } else {
      outputExt = "m4a";
    }
  } else if (format === "aac" || format === "high") {
    outputExt = "m4a";
    const highAudio = info.audioFormats?.find((a) => a.id === "high") || info.audioFormats?.find((a) => a.id === "m4a");
    if (highAudio && highAudio.filesize) expectedSize = highAudio.filesize;
  } else if (format === "opus") {
    outputExt = "webm";
  } else if (format === "m4a") {
    const m4aAudio = info.audioFormats?.find((a) => a.ext === "m4a");
    if (m4aAudio && m4aAudio.filesize) expectedSize = m4aAudio.filesize;
  }

  const filename = `${safeName}.${outputExt}`;
  const encoded = encodeURIComponent(filename);

  let headersSent = false;
  function sendAudioHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    const mimeMap = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      webm: "audio/webm",
      opus: "audio/opus",
      wav: "audio/wav",
      best: "audio/mp4",
    };
    const mime = mimeMap[outputExt] || mimeMap[format] || "audio/mpeg";
    res.setHeader("Content-Type", mime);
    try {
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}.${outputExt}"; filename*=UTF-8''${encoded}`);
    } catch (e) {
      console.error("[audio] header set failed", e.message);
      res.setHeader("Content-Disposition", `attachment; filename="audio.${outputExt}"`);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (expectedSize && format !== "mp3") {
      res.setHeader("Content-Length", String(expectedSize));
      res.setHeader("X-Expected-Size", String(expectedSize));
    } else if (expectedSize) {
      res.setHeader("X-Expected-Size", String(expectedSize));
    }
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, X-Expected-Size");
  }

  setPhase("audio", normalizedUrl, "processing");

  let ytdlpProc, ffmpegProc, stream, isConversion;
  try {
    const result = createAudioDownloadStream(normalizedUrl, { format });
    ytdlpProc = result.ytdlpProc;
    ffmpegProc = result.ffmpegProc;
    stream = result.stream;
    isConversion = result.isConversion;
  } catch (e) {
    console.error("[audio] create stream failed:", e.message);
    failDownload("audio", normalizedUrl, e.message);
    if (!res.headersSent) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    return res.end();
  }

  let stderrYtdlp = "";
  let stderrFfmpeg = "";
  let hasStartedStreaming = false;

  ytdlpProc.stderr.on("data", (c) => {
    stderrYtdlp += c.toString("utf-8");
    if (stderrYtdlp.length > 8192) stderrYtdlp = stderrYtdlp.slice(-8192);
  });
  if (ffmpegProc) {
    ffmpegProc.stderr.on("data", (c) => {
      stderrFfmpeg += c.toString("utf-8");
      if (stderrFfmpeg.length > 8192) stderrFfmpeg = stderrFfmpeg.slice(-8192);
    });
  }

  let cleaned = false;
  const killTree = (proc) => {
    if (!proc || proc.killed) return;
    try {
      if (process.platform === "win32") {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch {}
      } else {
        try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      }
    } catch {}
    try { proc.kill("SIGKILL"); } catch {}
  };
  const onClose = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (ytdlpProc) killTree(ytdlpProc); } catch {}
    try { if (ffmpegProc) killTree(ffmpegProc); } catch {}
    if (!hasStartedStreaming) {
      failDownload("audio", normalizedUrl, "Audio download cancelled");
    }
    if (!res.writableEnded) console.log("[audio] killed procs on client disconnect");
    cleanup();
  };
  const onAborted = () => { console.log("[audio] req aborted"); onClose(); };
  req.on("close", onClose);
  req.on("aborted", onAborted);
  req.on("error", onClose);
  res.on("close", onClose);
  res.on("error", onClose);
  res.on("finish", () => {
    cleaned = true;
    if (hasStartedStreaming) {
      completeDownload("audio", normalizedUrl);
    }
    cleanup();
  });

  stream.on("data", (chunk) => {
    if (!headersSent) {
      setPhase("audio", normalizedUrl, "downloading");
      sendAudioHeaders();
    }
    hasStartedStreaming = true;
    try {
      const ok = res.write(chunk);
      if (!ok) {
        stream.pause();
        res.once("drain", () => { try { stream.resume(); } catch {} });
      }
    } catch (e) {
      console.error("[audio] res.write failed (broken pipe)", e.message);
      onClose();
    }
  });

  stream.on("error", (err) => {
    console.error("[audio] stream error", err.message);
    failDownload("audio", normalizedUrl, err.message);
    cleanup();
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: "Audio download failed due to streaming error." });
    } else if (!hasStartedStreaming) {
      if (!res.writableEnded) res.end();
    }
  });
  if (ytdlpProc.stdout) {
    ytdlpProc.stdout.on("error", (err) => console.error("[audio] ytdlp stdout error", err.message));
  }
  if (ffmpegProc && ffmpegProc.stdin) {
    ffmpegProc.stdin.on("error", (err) => console.error("[audio] ffmpeg stdin error", err.message));
  }
  if (ffmpegProc && ffmpegProc.stdout) {
    ffmpegProc.stdout.on("error", (err) => console.error("[audio] ffmpeg stdout error", err.message));
  }

  let ytdlpCode = null;
  let ffmpegCode = null;

  ytdlpProc.on("close", (code) => {
    ytdlpCode = code;
    checkCompletion();
  });
  ytdlpProc.on("error", (err) => {
    console.error("[audio] ytdlp error", err.message);
    failDownload("audio", normalizedUrl, err.message);
    cleanup();
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: "Audio extraction failed." });
    } else if (!res.writableEnded) res.end();
  });

  if (ffmpegProc) {
    ffmpegProc.on("close", (code) => {
      ffmpegCode = code;
      if (code !== 0 && code !== null) {
        console.error(`[audio] ffmpeg exited ${code}:`, stderrFfmpeg.slice(0, 500));
      }
      checkCompletion();
    });
    ffmpegProc.on("error", (err) => {
      console.error("[audio] ffmpeg error", err.message);
      failDownload("audio", normalizedUrl, err.message);
      cleanup();
      if (!headersSent && !res.headersSent) {
        res.status(500).json({ error: "Audio conversion failed (ffmpeg)." });
      }
    });
  }

  function checkCompletion() {
    if (isConversion) {
      if (ffmpegCode === null) return;
      cleanup();
      const combined = (stderrYtdlp + " " + stderrFfmpeg).toLowerCase();

      if (ffmpegCode === 0 && ytdlpCode === 0) {
        if (hasStartedStreaming) {
          if (!res.writableEnded) res.end();
          console.log(`[audio] completed ${normalizedUrl} format=${format} hasStreamed=${hasStartedStreaming} conversion=true`);
        } else {
          console.error(`[audio] ffmpeg success but no data`, combined.slice(0,500));
          failDownload("audio", normalizedUrl, "Audio download produced no data");
          if (!headersSent && !res.headersSent && !res.writableEnded) {
            res.status(502).json({ error: "Audio download produced no data. Please try a different format." });
          } else if (!res.writableEnded) res.end();
        }
        return;
      }
      if (!hasStartedStreaming) {
        if (!headersSent && !res.headersSent) {
          let status = 500;
          let message = "Audio download failed. Please try again.";
          if (combined.includes("video unavailable")) { status = 404; message = "Video unavailable."; }
          else if (combined.includes("private video")) { status = 403; message = "This video is private."; }
          else if (combined.includes("confirm your age") || combined.includes("age-restricted") || combined.includes("age restricted") || combined.includes("inappropriate for some users") || (combined.includes("sign in") && combined.includes("age"))) { status = 403; message = "This video is age-restricted or requires sign-in."; }
          else if (combined.includes("members-only") || combined.includes("members only")) { status = 403; message = "This video is members-only or requires purchase."; }
          else if (combined.includes("copyright") || combined.includes("blocked")) { status = 403; message = "This video is blocked due to copyright or regional restrictions."; }
          else if (combined.includes("unsupported url")) { status = 400; message = "Unsupported URL."; }
          else if (combined.includes("http error 403") || combined.includes("forbidden")) { status = 502; message = "This audio quality is temporarily unavailable. Please try another format."; }
          else if (combined.includes("unable to download") || combined.toLowerCase().includes("conversion failed")) { status = 502; message = "Audio extraction or conversion failed."; }

          failDownload("audio", normalizedUrl, message);
          if (!res.writableEnded) res.status(status).json({ error: message, details: (stderrYtdlp || stderrFfmpeg).slice(0, 300) });
        } else {
          if (!res.writableEnded) res.end();
        }
      } else {
        if (!res.writableEnded) res.end();
      }
    } else {
      cleanup();
      const lower = stderrYtdlp.toLowerCase();
      if (ytdlpCode === 0) {
        if (hasStartedStreaming) {
          if (!res.writableEnded) res.end();
          console.log(`[audio] completed ${normalizedUrl} format=${format} hasStreamed=${hasStartedStreaming}`);
        } else {
          console.error(`[audio] ytdlp success but no data`, lower.slice(0,500));
          failDownload("audio", normalizedUrl, "Audio download produced no data");
          if (!headersSent && !res.headersSent && !res.writableEnded) {
            res.status(502).json({ error: "Audio download produced no data. Please try a different format." });
          } else if (!res.writableEnded) res.end();
        }
        return;
      }
      if (!hasStartedStreaming) {
        if (!headersSent && !res.headersSent) {
          let status = 500;
          let message = "Audio download failed. Please try again.";
          if (lower.includes("video unavailable")) { status = 404; message = "Video unavailable."; }
          else if (lower.includes("private video")) { status = 403; message = "This video is private."; }
          else if (lower.includes("confirm your age") || lower.includes("age-restricted") || lower.includes("age restricted") || lower.includes("inappropriate for some users") || (lower.includes("sign in") && lower.includes("age"))) { status = 403; message = "This video is age-restricted or requires sign-in."; }
          else if (lower.includes("members-only") || lower.includes("members only")) { status = 403; message = "This video is members-only or requires purchase."; }
          else if (lower.includes("copyright") || lower.includes("blocked")) { status = 403; message = "This video is blocked due to copyright or regional restrictions."; }
          else if (lower.includes("unsupported url")) { status = 400; message = "Unsupported URL."; }
          else if (lower.includes("http error 403") || lower.includes("forbidden")) { status = 502; message = "This audio quality is temporarily unavailable. Please try another format."; }
          else if (lower.includes("unsupported audio format") || lower.includes("no suitable")) { status = 400; message = `Unsupported audio format "${format}". Supported: mp3, m4a, best`; }
          else if (lower.includes("unable to download")) { status = 502; message = "Audio extraction failed."; }

          failDownload("audio", normalizedUrl, message);
          if (!res.writableEnded) res.status(status).json({ error: message, details: stderrYtdlp.slice(0, 300) });
        } else {
          if (!res.writableEnded) res.end();
        }
      } else {
        if (!res.writableEnded) res.end();
      }
    }
  }

  function cleanup() {
    req.off("close", onClose);
    res.off("close", onClose);
  }
});

export default router;
