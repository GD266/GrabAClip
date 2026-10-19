import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import infoRouter from "./routes/info.js";
import downloadRouter from "./routes/download.js";
import intelligenceRouter from "./routes/intelligence.js";
import audioRouter from "./routes/audio.js";
import { getActiveDownloads } from "./utils/downloadStatus.js";
import { recordError } from "./utils/errorLog.js";
import {
  getYtDlpVersion,
  getRuntimeDiagnostics,
  getCookiesInfo,
  LOW_MEMORY_HOST,
  SEQUENTIAL_MERGE,
  MEMORY_LIMIT_BYTES,
} from "./services/ytdlp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// The frontend may be hosted on another origin (e.g. Vercel) while the API
// runs in a container. CORS is open by default so that split deployment works;
// set CORS_ORIGIN (comma-separated) to restrict it in production.
const corsOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : "*",
    exposedHeaders: ["Content-Length", "Content-Disposition"],
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

// Request logging simple
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Health
// ytDlpVersion is informational: keep yt-dlp up to date (see AGENTS.md),
// stale versions get their media URLs rejected by YouTube (HTTP 403).
app.get("/api/health", async (req, res) => {
  const version = await getYtDlpVersion();
  const payload = { status: "ok", ytDlp: process.env.YTDLP_BIN || "yt-dlp", ytDlpVersion: version };
  // `?diagnostics=1` reports whether the container can run its native tools.
  if (req.query.diagnostics === "1") payload.diagnostics = getRuntimeDiagnostics();
  res.json(payload);
});

// Active downloads status
app.get("/api/downloads/status", (req, res) => {
  res.json({ downloads: getActiveDownloads() });
});

// API routes
app.use("/api/info", infoRouter);
app.use("/api/download/audio", audioRouter);
app.use("/api/download", downloadRouter);
app.use("/api/intelligence", intelligenceRouter);

// Serve frontend (includes the shared validator at /shared/validator.js).
app.use(express.static(path.join(ROOT, "public")));

// Fallback to index.html for SPA-like behavior (or just serve file for unknown routes that accept html)
app.get("*", (req, res) => {
  // If API not matched, serve index
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  recordError("express", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

// Never let a stray rejected promise / thrown async error kill the downloader.
// The entry is kept in memory and exposed by /api/health?diagnostics=1.
process.on("unhandledRejection", (reason) => {
  const entry = recordError("unhandledRejection", reason);
  console.error(`[unhandledRejection] ${entry.message}`);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

process.on("uncaughtException", (error) => {
  const entry = recordError("uncaughtException", error);
  console.error(`[uncaughtException] ${entry.message}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
});

app.listen(PORT, async () => {
  console.log(`Grab a Clip server running at http://localhost:${PORT}`);
  console.log(
    `host memory limit: ${Math.round(MEMORY_LIMIT_BYTES / 1024 / 1024)} MB ` +
      `(low-memory mode: ${LOW_MEMORY_HOST ? "on" : "off"}, sequential merge: ${SEQUENTIAL_MERGE ? "on" : "off"})`
  );
  const version = await getYtDlpVersion();
  console.log(`yt-dlp binary: ${process.env.YTDLP_BIN || "yt-dlp"}${version ? ` (version ${version})` : " (version unknown)"}`);
  const cookies = getCookiesInfo();
  console.log(`yt-dlp cookies: ${cookies.configured ? `configured (${cookies.source})` : "not configured"}`);
  if (!version) {
    console.warn("[startup] yt-dlp is not runnable. Check YTDLP_BIN and the container image; see /api/health?diagnostics=1.");
  }
});
