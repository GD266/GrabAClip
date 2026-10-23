import { Router } from "express";
import { validateInfoRequest } from "../utils/validation.js";
import { getVideoInfo } from "../services/ytdlp.js";
import { getVideoInfoCached } from "../utils/infoCache.js";
import { recordError } from "../utils/errorLog.js";

const router = Router();

router.post("/", async (req, res) => {
  const validation = validateInfoRequest(req.body);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    // Cached so the download click that follows does not pay for a second
    // extraction round trip.
    const info = await getVideoInfoCached(validation.normalizedUrl, () => getVideoInfo(validation.normalizedUrl));

    // Return expanded fields (optional fields may be null, but do not fail)
    return res.json({
      platform: info.platform,
      videoId: info.videoId,
      title: info.title,
      thumbnail: info.thumbnail,
      channel: info.channel,
      uploader: info.uploader,
      channelId: info.channelId,
      duration: info.duration,
      durationFormatted: info.durationFormatted,
      uploadDate: info.uploadDate,
      uploadDateFormatted: info.uploadDateFormatted,
      viewCount: info.viewCount,
      likeCount: info.likeCount,
      description: info.description,
      // Size-optimised plans (AV1/VP9) plus the H.264 compatibility set.
      formats: info.formats,
      formatsCompatible: info.formatsCompatible,
      audioFormats: info.audioFormats,
      audioSource: info.audioSource,
    });
  } catch (e) {
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";

    // Do not expose stack / internal details
    // Log server side
    console.error(`[info] error for ${validation.normalizedUrl}:`, e.original || e.message);
    recordError("info", e.original ? new Error(`${message} :: ${e.original}`) : e);

    return res.status(status).json({ error: message });
  }
});

export default router;
