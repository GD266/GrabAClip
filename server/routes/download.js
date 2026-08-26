import { Router } from "express";
import { validateDownloadQuery, sanitizeFilename, sanitizeAsciiFilename } from "../utils/validation.js";
import { createDownloadStream, getVideoInfo } from "../services/ytdlp.js";

const router = Router();

// GET /api/download?url=...&formatId=...
router.get("/", async (req, res) => {
  const validation = validateDownloadQuery(req.query);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { normalizedUrl, formatId, isHeight } = validation;

  // First, get video info to derive filename and validate availability
  // This also validates requested quality indirectly by allowing yt-dlp to handle it,
  // but we also want to verify the format exists if possible. We use getVideoInfo as title source.
  // If info fetch fails, propagate error.
  let title = "video";
  let effectiveFormatId = formatId;
  let effectiveIsHeight = isHeight;
  try {
    const info = await getVideoInfo(normalizedUrl);
    title = info.title;

    // If formatId provided as specific id, verify it exists (if requested format is height, skip check)
    if (formatId && !isHeight) {
      const exists = info.formats.some((f) => f.formatId === formatId);
      if (!exists) {
        return res.status(400).json({ error: `Requested format "${formatId}" is not available. Please choose another quality.` });
      }
    }
    if (formatId && isHeight) {
      const heightNum = parseInt(formatId, 10);
      const maxHeight = Math.max(...info.formats.map((f) => f.height), 0);
      if (heightNum > maxHeight + 100) {
        // Requested quality higher than available, yt-dlp will fallback to best
        console.warn(`[download] requested height ${heightNum} higher than max ${maxHeight}, will fallback to best`);
      }

      // Map height to actual formatId from info (prefer HLS pre-merged for reliability)
      // Find exact height match, otherwise closest lower height, else lowest available
      let matched = info.formats.find((f) => f.height === heightNum);
      if (!matched) {
        // Find closest lower height
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
        effectiveIsHeight = false; // now we have concrete format id
      } else {
        // No formats found, fallback to height selector logic
        console.warn(`[download] no format matched for height ${heightNum}, using height selector`);
      }
    }
  } catch (e) {
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";
    console.error(`[download] info fetch failed for ${normalizedUrl}:`, e.original || e.message);
    return res.status(status).json({ error: message });
  }

  const safeName = sanitizeFilename(title);
  const filename = `${safeName}.mp4`;
  const encoded = encodeURIComponent(filename);
  // ASCII fallback for the quoted filename part (Node validates header as Latin1)
  const asciiFallback = sanitizeAsciiFilename(safeName);

  let headersSent = false;
  function sendDownloadHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    // Use RFC5987 for UTF-8 filename* and ASCII fallback for filename
    // Both are needed for compatibility; filename is strictly ASCII
    try {
      res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback}.mp4"; filename*=UTF-8''${encoded}`);
    } catch (e) {
      // Fallback to ASCII-only if header still invalid
      console.error("[download] header set failed, using fallback", e.message);
      res.setHeader("Content-Disposition", `attachment; filename="video.mp4"`);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  let downloadProc;
  try {
    downloadProc = createDownloadStream(normalizedUrl, { formatId: effectiveFormatId, isHeight: effectiveIsHeight });
  } catch (e) {
    console.error("[download] create stream failed:", e.message);
    if (!res.headersSent) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    return res.end();
  }

  let stderr = "";
  let hasStartedStreaming = false;
  let errorSent = false;

  // Handle stderr for error classification
  downloadProc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
    // Limit stderr capture
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  // If client aborts, kill process and cleanup
  const onClose = () => {
    if (downloadProc && !downloadProc.killed) {
      downloadProc.kill("SIGKILL");
    }
  };
  req.on("close", onClose);
  res.on("close", onClose);

  // Timeout handling is inside createDownloadStream (5min)

  let stdoutEnded = false;

  downloadProc.stdout.on("data", (chunk) => {
    if (!headersSent) sendDownloadHeaders();
    hasStartedStreaming = true;
    // Backpressure handled by pipe? We write manually to respect streaming without loading all in memory
    const ok = res.write(chunk);
    if (!ok) {
      downloadProc.stdout.pause();
      res.once("drain", () => downloadProc.stdout.resume());
    }
  });

  downloadProc.stdout.on("end", () => {
    stdoutEnded = true;
    // Do not end response here - wait for 'close' event to determine success/failure
    // If process already closed with success, we will end in close handler
    // But if close not yet fired, we keep connection open briefly
    // For immediate success where close hasn't fired yet, set a short fallback
    setTimeout(() => {
      if (stdoutEnded && !res.writableEnded && !headersSent) {
        // No data and process hasn't closed yet? will be handled by close
      } else if (stdoutEnded && hasStartedStreaming && !res.writableEnded) {
        // If we have streamed and stdout ended but close hasn't fired within 1s, end gracefully
        // Wait for close to handle error codes; this is fallback
      }
    }, 1000);
  });

  downloadProc.on("error", (err) => {
    console.error("[download] proc error:", err.message);
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
      // Success - ensure response ends
      if (hasStartedStreaming) {
        if (!res.writableEnded) res.end();
      } else {
        // No data streamed but exit 0 - treat as empty download error
        console.error(`[download] yt-dlp exited 0 but no data streamed:`, stderr.slice(0, 500));
        if (!headersSent && !res.headersSent && !res.writableEnded) {
          res.status(502).json({ error: "Download produced no data. Please try a different quality." });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      console.log(`[download] completed for ${normalizedUrl} format=${effectiveFormatId || "best"} hasStreamed=${hasStartedStreaming}`);
      return;
    }

    // Failure case (code !==0)
    console.error(`[download] yt-dlp exited code ${code}:`, stderr.slice(0, 500));

      if (!hasStartedStreaming) {
        // No bytes streamed at all - we can still send proper JSON error if headers not yet sent
        if (!headersSent && !res.headersSent) {
          // Classify error - order matters: auth before generic 403
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

          if (!res.writableEnded) res.status(status).json({ error: message, details: stderr.slice(0, 300) });
        } else {
          if (!res.writableEnded) res.end();
        }
    } else {
      // Partial stream already sent, just end (client may have partial file)
      if (!res.writableEnded) res.end();
    }
  });

  function cleanup() {
    req.off("close", onClose);
    res.off("close", onClose);
    // Ensure proc killed if still alive and response ended
    if (res.writableEnded && downloadProc && !downloadProc.killed) {
      // No need to kill if naturally ended, but ensure
    }
  }

  // Note: We already started streaming via stdout 'data' handler. No pipe needed.
});

export default router;
