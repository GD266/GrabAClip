import { Router } from "express";
import { sanitizeFilename, sanitizeAsciiFilename, isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";
import { createAudioDownloadStream, getVideoInfo } from "../services/ytdlp.js";

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
  const allowed = new Set(["best", "mp3", "m4a", "aac", "opus", "wav"]);
  if (!allowed.has(format)) {
    return res.status(400).json({ error: `Unsupported audio format "${formatParam}". Supported: mp3, m4a, best` });
  }

  // Get video info for title and to check availability
  let title = "audio";
  let info = null;
  try {
    info = await getVideoInfo(normalizedUrl);
    title = info.title;
  } catch (e) {
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";
    console.error(`[audio] info fetch failed for ${normalizedUrl}:`, e.original || e.message);
    return res.status(status).json({ error: message });
  }

  const safeName = sanitizeFilename(title);
  const asciiFallback = sanitizeAsciiFilename(safeName);

  // Determine output ext and content-type
  let outputExt = format;
  if (format === "best") {
    // Use best audio ext from info if available
    const bestAudio = info.audioFormats?.find((a) => a.id === "best") || info.audioFormats?.[0];
    if (bestAudio) {
      outputExt = bestAudio.ext;
      // Normalize webm/opus to webm, m4a stays m4a
      if (outputExt === "webm") outputExt = "webm";
      else if (outputExt === "m4a") outputExt = "m4a";
      else outputExt = bestAudio.ext;
    } else {
      outputExt = "m4a";
    }
  } else if (format === "aac") {
    outputExt = "m4a";
  } else if (format === "opus") {
    outputExt = "webm";
  }

  const filename = `${safeName}.${outputExt}`;
  const encoded = encodeURIComponent(filename);

  let headersSent = false;
  function sendAudioHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    // Content-Type based on ext
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
  }

  let ytdlpProc, ffmpegProc, stream, isConversion;
  try {
    const result = createAudioDownloadStream(normalizedUrl, { format });
    ytdlpProc = result.ytdlpProc;
    ffmpegProc = result.ffmpegProc;
    stream = result.stream;
    isConversion = result.isConversion;
    // If best resolved to different ext via info, update outputExt handling already done
    // For mp3 conversion, outputExt already mp3
  } catch (e) {
    console.error("[audio] create stream failed:", e.message);
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

  const onClose = () => {
    try { if (ytdlpProc && !ytdlpProc.killed) ytdlpProc.kill("SIGKILL"); } catch {}
    try { if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill("SIGKILL"); } catch {}
  };
  req.on("close", onClose);
  res.on("close", onClose);

  stream.on("data", (chunk) => {
    if (!headersSent) sendAudioHeaders();
    hasStartedStreaming = true;
    const ok = res.write(chunk);
    if (!ok) {
      stream.pause();
      res.once("drain", () => stream.resume());
    }
  });

  stream.on("end", () => {
    // Wait for close events to determine success
  });

  stream.on("error", (err) => {
    console.error("[audio] stream error", err.message);
    cleanup();
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: "Audio download failed due to streaming error." });
    } else if (!hasStartedStreaming) {
      if (!res.writableEnded) res.end();
    }
  });

  let ytdlpCode = null;
  let ffmpegCode = null;

  ytdlpProc.on("close", (code) => {
    ytdlpCode = code;
    checkCompletion();
  });
  ytdlpProc.on("error", (err) => {
    console.error("[audio] ytdlp error", err.message);
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
      cleanup();
      if (!headersSent && !res.headersSent) {
        res.status(500).json({ error: "Audio conversion failed (ffmpeg)." });
      }
    });
  }

  function checkCompletion() {
    // For native (no ffmpeg), ytdlp close determines completion
    // For conversion, need both to close; ffmpeg close is final
    if (isConversion) {
      if (ffmpegCode === null) return; // wait for ffmpeg
      // ffmpeg is final stage
      cleanup();
      const lowerY = stderrYtdlp.toLowerCase();
      const lowerF = stderrFfmpeg.toLowerCase();
      const combined = (stderrYtdlp + " " + stderrFfmpeg).toLowerCase();

      if (ffmpegCode === 0 && ytdlpCode === 0) {
        if (hasStartedStreaming) {
          if (!res.writableEnded) res.end();
          console.log(`[audio] completed ${normalizedUrl} format=${format} hasStreamed=${hasStartedStreaming} conversion=true`);
        } else {
          console.error(`[audio] ffmpeg success but no data`, combined.slice(0,500));
          if (!headersSent && !res.headersSent && !res.writableEnded) {
            res.status(502).json({ error: "Audio download produced no data. Please try a different format." });
          } else if (!res.writableEnded) res.end();
        }
        return;
      }
      // Failure before streaming -> send JSON
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
          else if (combined.includes("unable to download") || lowerF.includes("conversion failed")) { status = 502; message = "Audio extraction or conversion failed."; }
          else if (lowerF.includes("unknown encoder") || lowerF.includes("encoder.*not found")) { status = 500; message = "Audio conversion failed (ffmpeg encoder missing)."; }

          if (!res.writableEnded) res.status(status).json({ error: message, details: (stderrYtdlp || stderrFfmpeg).slice(0, 300) });
        } else {
          if (!res.writableEnded) res.end();
        }
      } else {
        if (!res.writableEnded) res.end();
      }
    } else {
      // Native
      cleanup();
      const lower = stderrYtdlp.toLowerCase();
      if (ytdlpCode === 0) {
        if (hasStartedStreaming) {
          if (!res.writableEnded) res.end();
          console.log(`[audio] completed ${normalizedUrl} format=${format} hasStreamed=${hasStartedStreaming}`);
        } else {
          console.error(`[audio] ytdlp success but no data`, lower.slice(0,500));
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
