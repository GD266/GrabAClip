import { getVideoInfo } from "./ytdlp.js";
import { getTranscript } from "./transcript.js";
import { getAIProvider } from "./ai/factory.js";
import { isYouTubeUrl, normalizeYouTubeUrl } from "../utils/validation.js";

/**
 * Build intelligence for a YouTube video
 * Returns structured JSON, never fails entire request if optional parts unavailable
 */
export async function buildIntelligence(rawUrl) {
  if (!isYouTubeUrl(rawUrl)) {
    const err = new Error("Invalid YouTube URL. Please provide a valid YouTube video URL.");
    err.status = 400;
    throw err;
  }
  const url = normalizeYouTubeUrl(rawUrl);

  // 1. Video info (required) - with expanded fields
  let videoInfo;
  try {
    videoInfo = await getVideoInfo(url);
  } catch (e) {
    // Propagate with proper status
    throw e;
  }

  // 2. Transcript (optional) - do not fail if unavailable
  let transcriptResult = { available: false, text: null, language: null, isAuto: null, error: "Transcript unavailable" };
  try {
    transcriptResult = await getTranscript(url);
  } catch (e) {
    console.warn(`[intelligence] transcript error for ${url}:`, e.message);
    transcriptResult = { available: false, text: null, language: null, isAuto: null, error: "Transcript unavailable" };
  }

  // Normalize transcript for AI (handle very long)
  let transcriptForAI = null;
  if (transcriptResult.available && transcriptResult.text) {
    transcriptForAI = transcriptResult.text;
    // If very long, log
    if (transcriptForAI.length > 20000) {
      console.log(`[intelligence] long transcript ${transcriptForAI.length} chars, will truncate for AI`);
    }
  }

  // 3. AI summary (optional) - based primarily on transcript when available, fallback to description
  let aboutVideo = null;
  let aiError = null;
  try {
    const provider = getAIProvider();
    const summary = await provider.generate({
      transcript: transcriptForAI,
      metadata: {
        title: videoInfo.title,
        channel: videoInfo.channel,
        description: videoInfo.description,
        viewCount: videoInfo.viewCount,
        likeCount: videoInfo.likeCount,
        uploadDate: videoInfo.uploadDate,
      },
    });
    aboutVideo = {
      overview: summary.overview,
      mainTopics: summary.mainTopics,
      keyPoints: summary.keyPoints,
      provider: provider.name,
      generatedAt: new Date().toISOString(),
      isFallback: provider.name === "MockProvider" ? true : false,
    };
  } catch (e) {
    console.error(`[intelligence] AI generation failed for ${url}:`, e.message, e.code || "", e.status || "");
    // Map AI errors to user-friendly messages without exposing secrets
    let userMsg = "AI generation failed";
    if (e.code === "NO_API_KEY" || e.status === 401) userMsg = "AI provider not configured or invalid API key";
    else if (e.code === "RATE_LIMIT" || e.status === 429) userMsg = "AI rate limit exceeded, please try later";
    else if (e.code === "TIMEOUT" || e.status === 504) userMsg = "AI request timed out";
    else if (e.status >= 500) userMsg = "AI provider error, please try later";
    else userMsg = e.message.slice(0, 200);

    aiError = userMsg;
    // Still provide aboutVideo as null, but request succeeds overall
    aboutVideo = null;
  }

  // 4. Build final structured response (predictable, type-safe)
  return {
    video: {
      videoId: videoInfo.videoId,
      title: videoInfo.title,
      channel: videoInfo.channel,
      uploader: videoInfo.uploader,
      channelId: videoInfo.channelId,
      thumbnail: videoInfo.thumbnail,
      duration: videoInfo.duration,
      durationFormatted: videoInfo.durationFormatted,
      uploadDate: videoInfo.uploadDate,
      uploadDateFormatted: videoInfo.uploadDateFormatted,
      viewCount: videoInfo.viewCount,
      likeCount: videoInfo.likeCount,
      description: videoInfo.description,
      formats: videoInfo.formats,
    },
    transcript: {
      available: transcriptResult.available,
      text: transcriptResult.text, // may be null
      language: transcriptResult.language,
      isAuto: transcriptResult.isAuto,
      status: transcriptResult.available ? "available" : "unavailable",
      error: transcriptResult.available ? null : (transcriptResult.error || "Transcript unavailable"),
    },
    intelligence: {
      aboutVideo, // null if AI failed
      aiError, // string or null
      hasTranscript: transcriptResult.available,
      generated: !!aboutVideo,
    },
  };
}
