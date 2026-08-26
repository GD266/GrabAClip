import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import infoRouter from "./routes/info.js";
import downloadRouter from "./routes/download.js";
import intelligenceRouter from "./routes/intelligence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
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
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", ytDlp: process.env.YTDLP_BIN || "yt-dlp" });
});

// API routes
app.use("/api/info", infoRouter);
app.use("/api/download", downloadRouter);
app.use("/api/intelligence", intelligenceRouter);

// Serve frontend
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
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Grab a Clip server running at http://localhost:${PORT}`);
  console.log(`yt-dlp binary: ${process.env.YTDLP_BIN || "yt-dlp"}`);
});
