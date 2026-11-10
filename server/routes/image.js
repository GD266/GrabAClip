import { Router } from "express";
import {
  detectPlatform,
  normalizeMediaUrl,
  sanitizeAsciiFilename,
  sanitizeFilename,
} from "../utils/validation.js";
import { getMediaInfo } from "../services/media.js";
import { getVideoInfoCached } from "../utils/infoCache.js";
import { fetchFacebookImage, FACEBOOK_LIMITS } from "../services/facebook.js";
import { createZipBuffer } from "../utils/zip.js";
import { recordError } from "../utils/errorLog.js";

const MAX_ZIP_TOTAL_BYTES = 120 * 1024 * 1024;

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function sendError(res, error, context) {
  const status = error?.status || 500;
  const message = error?.message || "Image download failed.";
  if (status >= 500) {
    console.error(`[${context}]`, error?.original || error?.stack || message);
    recordError(context, error);
  }
  if (!res.headersSent) {
    return res.status(status).json({
      error: message,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
    });
  }
  if (!res.writableEnded) res.end();
}

async function loadFacebookImages(rawUrl, { signal = null } = {}) {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw httpError("A Facebook link is required.", 400, "INVALID_URL");
  }
  const normalizedUrl = normalizeMediaUrl(rawUrl);
  if (!normalizedUrl || detectPlatform(normalizedUrl) !== "facebook") {
    throw httpError("Only public Facebook photo and image-post links are supported here.", 400, "UNSUPPORTED_URL");
  }

  const info = await getVideoInfoCached(normalizedUrl, () => getMediaInfo(normalizedUrl, { signal }));
  const images = Array.isArray(info?._images) ? info._images : [];
  if (images.length === 0) {
    throw httpError(
      "This Facebook link does not contain a downloadable image. Use the Video tab for video posts.",
      400,
      "NOT_IMAGE_POST"
    );
  }
  return { info, images, normalizedUrl };
}

function parseImageIndex(value, length) {
  if (value == null || value === "") return 0;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw httpError("Invalid image selection.", 400, "INVALID_IMAGE");
  }
  return index;
}

function extensionForContentType(contentType) {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "image/avif") return "avif";
  if (type === "image/bmp") return "bmp";
  if (type === "image/svg+xml") return "svg";
  return "jpg";
}

function contentDisposition(filename, asciiFallback, mode = "attachment") {
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", onClose);
  res.on("close", onClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", onClose);
      res.off("close", onClose);
    },
  };
}

async function sendSingleImage(req, res, { attachment }) {
  const controller = abortOnDisconnect(req, res);
  try {
    const { info, images } = await loadFacebookImages(req.query.url, { signal: controller.signal });
    const index = parseImageIndex(req.query.index, images.length);
    const image = images[index];
    const fetched = await fetchFacebookImage(image.url, { signal: controller.signal });
    const ext = extensionForContentType(fetched.contentType);
    const safeTitle = sanitizeFilename(info.title || "facebook-photo");
    const filename = `${safeTitle}-${String(index + 1).padStart(2, "0")}.${ext}`;
    const ascii = sanitizeAsciiFilename(filename);

    res.status(200);
    res.setHeader("Content-Type", fetched.contentType || "image/jpeg");
    res.setHeader("Content-Length", String(fetched.buffer.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      contentDisposition(filename, ascii, attachment ? "attachment" : "inline")
    );
    if (attachment) {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "private, max-age=600");
    }
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");
    return res.end(fetched.buffer);
  } catch (error) {
    return sendError(res, error, attachment ? "image:download" : "image:preview");
  } finally {
    controller.cleanup();
  }
}

async function sendImagesZip(req, res) {
  const controller = abortOnDisconnect(req, res);
  try {
    const { info, images } = await loadFacebookImages(req.query.url, { signal: controller.signal });
    if (images.length > FACEBOOK_LIMITS.MAX_GALLERY_IMAGES) {
      throw httpError("This Facebook post has too many images to package.", 413, "TOO_MANY_IMAGES");
    }

    const entries = [];
    let totalBytes = 0;
    for (let index = 0; index < images.length; index += 1) {
      const fetched = await fetchFacebookImage(images[index].url, { signal: controller.signal });
      totalBytes += fetched.buffer.length;
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
        throw httpError("This Facebook gallery is too large to package.", 413, "GALLERY_TOO_LARGE");
      }
      const ext = extensionForContentType(fetched.contentType);
      const base = sanitizeFilename(info.title || "facebook-photo");
      entries.push({
        name: `${base}-${String(index + 1).padStart(2, "0")}.${ext}`,
        data: fetched.buffer,
      });
    }

    const archive = createZipBuffer(entries);
    const safeTitle = sanitizeFilename(info.title || "facebook-photos");
    const filename = `${safeTitle}.zip`;
    const ascii = sanitizeAsciiFilename(filename);

    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(archive.length));
    res.setHeader("Content-Disposition", contentDisposition(filename, ascii, "attachment"));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");
    return res.end(archive);
  } catch (error) {
    return sendError(res, error, "images:zip");
  } finally {
    controller.cleanup();
  }
}

export function createImageRouter({ download = false } = {}) {
  const router = Router();
  router.get("/", (req, res) => sendSingleImage(req, res, { attachment: download }));
  return router;
}

export function createImagesZipRouter() {
  const router = Router();
  router.get("/", sendImagesZip);
  return router;
}
