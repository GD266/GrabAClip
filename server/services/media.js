/**
 * Platform-aware info dispatcher.
 *
 * YouTube, X and Instagram keep using getVideoInfo(). Facebook needs an extra
 * decision: a public post may be a video (yt-dlp) or a photo/gallery (public
 * Open Graph metadata). getFacebookInfo makes that choice.
 */

import { detectPlatform } from "../utils/validation.js";
import { getVideoInfo } from "./ytdlp.js";
import { getFacebookInfo } from "./facebook.js";

export async function getMediaInfo(rawUrl, options = {}) {
  const platform = detectPlatform(rawUrl);
  if (platform === "facebook") {
    return getFacebookInfo(rawUrl, { ...options, getVideoInfo });
  }
  return getVideoInfo(rawUrl, options);
}
