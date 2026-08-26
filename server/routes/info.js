import { Router } from "express";
import { validateInfoRequest } from "../utils/validation.js";
import { getVideoInfo } from "../services/ytdlp.js";

const router = Router();

router.post("/", async (req, res) => {
  const validation = validateInfoRequest(req.body);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const info = await getVideoInfo(validation.normalizedUrl);

    // Return expanded fields (optional fields may be null, but do not fail)
    return res.json({
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
      formats: info.formats,
    });
  } catch (e) {
    const status = e.status || 500;
    const message = e.message || "Failed to retrieve video information.";

    // Do not expose stack / internal details
    // Log server side
    console.error(`[info] error for ${validation.normalizedUrl}:`, e.original || e.message);

    return res.status(status).json({ error: message });
  }
});

export default router;
