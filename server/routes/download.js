import { Router } from "express";
import { execSync } from "node:child_process";
import { validateDownloadQuery, sanitizeFilename, sanitizeAsciiFilename } from "../utils/validation.js";
import { createDownloadStream, getVideoInfo } from "../services/ytdlp.js";
import { startDownload, setPhase, completeDownload, failDownload, isActive, removeDownload } from "../utils/downloadStatus.js";

const router = Router();

// GET /api/download?url=...&formatId=...
router.get("/", async (req, res) => {
  const validation = validateDownloadQuery(req.query);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { normalizedUrl, formatId, isHeight } = validation;

  // Prevent duplicate active downloads for same video + quality
  if (isActive("video", normalizedUrl)) {
    return res.status(429).json({ error: "A download for this video is already in progress. Please wait or refresh the page." });
  }

  const status = startDownload("video", normalizedUrl);

  let title = "video";
  let effectiveFormatId = formatId;
  let effectiveIsHeight = isHeight;
  let info = null;
  const abortController = new AbortController();
  let clientAborted = false;
  const onClientAbort = () => {
    clientAborted = true;
    try { abortController.abort(); } catch {}
  };
  req.on("close", onClientAbort);
  req.on("aborted", onClientAbort);

  setPhase("video", normalizedUrl, "fetching");
  try {
    info = await getVideoInfo(normalizedUrl, { signal: abortController.signal });
    if (clientAborted) {
      console.log("[download] client aborted during info fetch, aborting");
      removeDownload("video", normalizedUrl);
      return;
    }
    title = info.title;

    if (formatId && !isHeight) {
      const exists = info.formats.some((f) => f.formatId === formatId);
      if (!exists) {
        failDownload("video", normalizedUrl, `Format "${formatId}" is not available.`);
        return res.status(400).json({ error: `Requested format "${formatId}" is not available. Please choose another quality.` });
      }
    }
    if (formatId && isHeight) {
      const heightNum = parseInt(formatId, 10);
      const maxHeight = Math.max(...info.formats.map((f) => f.height), 0);
      if (heightNum > maxHeight + 100) {
        console.warn(`[download] requested height ${heightNum} higher than max ${maxHeight}, will fallback to best`);
      }

      let matched = info.formats.find((f) => f.height === heightNum);
      if (!matched) {
        const sorted = [...info.formats].sort((a, b) => b.height - a.height);
        matched = sorted.find((f) => f.height <= heightNum) || sorted[sorted.length - 1];
        if (matched) {
          console.log(`[download] height ${heightNum} mapped to format ${matched.formatId} (${matched.height}p, proto=${matched.protocol})`);
        }
      } else {
        console.log(`[download] height ${heightNum} exact match -> format ${matched.formatId} proto=${matched.protocol}`);
      }

      if (matched) {
        effectiveFormatId = matched.formatId;
        effectiveIsHeight = false;
      } else {
        console.warn(`[download] no format matched for height ${heightNum}, using height selector`);
      }
    }
  } catch (e) {
    if (e.code === "ABORTED" || e.status === 499 || clientAborted) {
      console.log("[download] aborted during info fetch");
      removeDownload("video", normalizedUrl);
      return;
    }
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";
    console.error(`[download] info fetch failed for ${normalizedUrl}:`, e.original || e.message);
    failDownload("video", normalizedUrl, message);
    return res.status(status).json({ error: message });
  } finally {
    try { req.off("close", onClientAbort); req.off("aborted", onClientAbort); } catch {}
  }

  if (clientAborted || req.destroyed || res.writableEnded) {
    console.log("[download] client already disconnected before download, aborting");
    removeDownload("video", normalizedUrl);
    return;
  }

  const safeName = sanitizeFilename(title);
  const filename = `${safeName}.mp4`;
  const encoded = encodeURIComponent(filename);
  const asciiFallback = sanitizeAsciiFilename(safeName);

  let expectedSize = null;
  try {
    const bestMatch = info.formats.find((f) => f.formatId === effectiveFormatId);
    if (bestMatch && bestMatch.filesize) expectedSize = bestMatch.filesize;
  } catch {}

  let headersSent = false;
  function sendDownloadHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    try {
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}.mp4"; filename*=UTF-8''${encoded}`);
    } catch (e) {
      console.error("[download] header set failed, using fallback", e.message);
      res.setHeader("Content-Disposition", `attachment; filename="video.mp4"`);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (expectedSize) {
      res.setHeader("Content-Length", String(expectedSize));
      res.setHeader("X-Expected-Size", String(expectedSize));
    }
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, X-Expected-Size");
  }

  setPhase("video", normalizedUrl, "processing");

  let downloadProc;
  try {
    downloadProc = createDownloadStream(normalizedUrl, { formatId: effectiveFormatId, isHeight: effectiveIsHeight });
  } catch (e) {
    console.error("[download] create stream failed:", e.message);
    failDownload("video", normalizedUrl, e.message);
    if (!res.headersSent) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    return res.end();
  }

  let stderr = "";
  let hasStartedStreaming = false;
  let errorSent = false;

  downloadProc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  // Backend reliability: ensure yt-dlp (and its ffmpeg child) cannot remain after disconnect
  let cleaned = false;
  const killProcTree = (proc) => {
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
    try {
      if (downloadProc && !downloadProc.killed) {
        killProcTree(downloadProc);
        console.log("[download] killed yt-dlp due to client disconnect");
      }
    } catch {}
    if (!hasStartedStreaming) {
      failDownload("video", normalizedUrl, "Download cancelled");
    }
    cleanup();
  };
  const onReqAborted = () => {
    console.log("[download] req aborted");
    onClose();
  };
  req.on("close", onClose);
  req.on("aborted", onReqAborted);
  req.on("error", onClose);
  res.on("close", onClose);
  res.on("error", onClose);
  res.on("finish", () => {
    cleaned = true;
    if (hasStartedStreaming) {
      completeDownload("video", normalizedUrl);
    }
    cleanup();
  });

  let stdoutEnded = false;
  let lastByteTime = Date.now();

  downloadProc.stdout.on("data", (chunk) => {
    lastByteTime = Date.now();
    if (!headersSent) {
      setPhase("video", normalizedUrl, "downloading");
      sendDownloadHeaders();
    }
    hasStartedStreaming = true;
    try {
      const ok = res.write(chunk);
      if (!ok) {
        downloadProc.stdout.pause();
        res.once("drain", () => {
          try { downloadProc.stdout.resume(); } catch {}
        });
      }
    } catch (e) {
      console.error("[download] res.write failed (broken pipe)", e.message);
      onClose();
    }
  });

  downloadProc.stdout.on("error", (err) => {
    console.error("[download] stdout error", err.message);
    if (!headersSent && !res.headersSent && !res.writableEnded) {
      res.status(502).json({ error: "Download streaming error." });
    }
  });

  downloadProc.stderr.on("error", (err) => {
    console.error("[download] stderr error", err.message);
  });

  downloadProc.stdout.on("end", () => {
    stdoutEnded = true;
  });

  downloadProc.on("error", (err) => {
    console.error("[download] proc error:", err.message);
    failDownload("video", normalizedUrl, err.message);
    cleanup();
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: "Download failed due to server error." });
    } else if (!hasStartedStreaming) {
      if (!res.writableEnded) res.end();
    } else {
      if (!res.writableEnded) res.end();
    }
  });

  downloadProc.on("close", (code) => {
    cleanup();
    const lower = stderr.toLowerCase();

    if (code === 0) {
      if (hasStartedStreaming) {
        if (!res.writableEnded) res.end();
      } else {
        console.error(`[download] yt-dlp exited 0 but no data streamed:`, stderr.slice(0, 500));
        failDownload("video", normalizedUrl, "Download produced no data");
        if (!headersSent && !res.headersSent && !res.writableEnded) {
          res.status(502).json({ error: "Download produced no data. Please try a different quality." });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      console.log(`[download] completed for ${normalizedUrl} format=${effectiveFormatId || "best"} hasStreamed=${hasStartedStreaming}`);
      return;
    }

    console.error(`[download] yt-dlp exited code ${code}:`, stderr.slice(0, 500));

    if (!hasStartedStreaming) {
      if (!headersSent && !res.headersSent) {
        let status = 500;
        let message = "Download failed. Please try again.";
        if (lower.includes("video unavailable")) { status = 404; message = "Video unavailable."; }
        else if (lower.includes("private video")) { status = 403; message = "This video is private."; }
        else if (
          lower.includes("confirm your age") ||
          lower.includes("age-restricted") ||
          lower.includes("age restricted") ||
          lower.includes("inappropriate for some users") ||
          (lower.includes("sign in") && lower.includes("age")) ||
          lower.includes("login required") ||
          lower.includes("requires authentication")
        ) { status = 403; message = "This video is age-restricted or requires sign-in."; }
        else if (lower.includes("members-only") || lower.includes("members only") || lower.includes("join this channel")) { status = 403; message = "This video is members-only or requires purchase."; }
        else if (lower.includes("copyright") || lower.includes("blocked")) { status = 403; message = "This video is blocked due to copyright or regional restrictions."; }
        else if (lower.includes("requested format not available") || lower.includes("format not found")) { status = 400; message = "Requested quality not available. Please choose another quality."; }
        else if (lower.includes("unsupported url")) { status = 400; message = "Unsupported URL."; }
        else if (lower.includes("http error 403") || lower.includes("forbidden")) { status = 502; message = "This quality is temporarily unavailable (403). Please try a different quality (e.g., 720p or 480p)."; }
        else if (lower.includes("unable to download")) { status = 502; message = "Failed to download video data. Please try a different quality."; }

        failDownload("video", normalizedUrl, message);
        if (!res.writableEnded) res.status(status).json({ error: message, details: stderr.slice(0, 300) });
      } else {
        if (!res.writableEnded) res.end();
      }
    } else {
      if (!res.writableEnded) res.end();
    }
  });

  function cleanup() {
    req.off("close", onClose);
    res.off("close", onClose);
  }
});

export default router;
