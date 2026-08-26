// Frontend logic for Grab a Clip - Phase 1

const urlInput = document.getElementById("urlInput");
const getVideoBtn = document.getElementById("getVideoBtn");
const statusEl = document.getElementById("status");
const videoSection = document.getElementById("videoSection");
const thumbEl = document.getElementById("thumb");
const vTitleEl = document.getElementById("vTitle");
const vChannelEl = document.getElementById("vChannel");
const vDurationEl = document.getElementById("vDuration");
const vIdEl = document.getElementById("vId");
const qualitySelect = document.getElementById("qualitySelect");
const downloadBtn = document.getElementById("downloadBtn");
const downloadStatusEl = document.getElementById("downloadStatus");

// Phase 2 elements
const vUploadDateEl = document.getElementById("vUploadDate");
const vViewsEl = document.getElementById("vViews");
const vLikesEl = document.getElementById("vLikes");
const vDescriptionEl = document.getElementById("vDescription");
const intelligenceSection = document.getElementById("intelligenceSection");
const getIntelligenceBtn = document.getElementById("getIntelligenceBtn");
const intelligenceStatusEl = document.getElementById("intelligenceStatus");
const intelligenceContentEl = document.getElementById("intelligenceContent");
const transcriptStatusEl = document.getElementById("transcriptStatus");
const transcriptTextEl = document.getElementById("transcriptText");
const aiOverviewEl = document.getElementById("aiOverview");
const aiTopicsEl = document.getElementById("aiTopics");
const aiKeyPointsEl = document.getElementById("aiKeyPoints");
const aiProviderEl = document.getElementById("aiProvider");
const aiErrorEl = document.getElementById("aiError");

let currentUrl = "";
let currentFormats = [];

// Inline YouTube validator (mirrors shared/validator.js)
function extractVideoId(urlString) {
  try {
    const url = new URL(urlString.trim());
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be" || host === "www.youtu.be") {
      const id = url.pathname.slice(1).split("/")[0].split("?")[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      return null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && ["embed", "v", "shorts", "live"].includes(parts[0])) {
        if (/^[a-zA-Z0-9_-]{11}$/.test(parts[1])) return parts[1];
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function isYouTubeUrl(s) {
  if (!s || typeof s !== "string") return false;
  try {
    const url = new URL(s.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    const allowed = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "gaming.youtube.com",
      "youtu.be",
      "www.youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ]);
    const isAllowed = allowed.has(host) || host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com");
    if (!isAllowed) return false;
    return extractVideoId(s) !== null;
  } catch {
    return false;
  }
}

function setStatus(el, message, type = "") {
  el.textContent = message;
  el.className = "status" + (type ? ` ${type}` : "");
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `~${mb.toFixed(1)} MB`;
  return `~${(bytes / 1024).toFixed(0)} KB`;
}

async function getVideo() {
  const url = urlInput.value.trim();

  if (!url) {
    setStatus(statusEl, "Please paste a YouTube URL.", "error");
    return;
  }
  if (!isYouTubeUrl(url)) {
    setStatus(statusEl, "Invalid YouTube URL. Use https://www.youtube.com/watch?v=... or https://youtu.be/...", "error");
    return;
  }

  setStatus(statusEl, "Fetching video information...", "loading");
  setStatus(downloadStatusEl, "", "");
  getVideoBtn.disabled = true;
  getVideoBtn.textContent = "Loading...";
  videoSection.classList.add("hidden");

  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to retrieve video information.");
    }

    // Display info
    currentUrl = url;
    currentFormats = data.formats || [];

    vTitleEl.textContent = data.title || "Untitled";
    vChannelEl.textContent = data.channel || "Unknown";
    vDurationEl.textContent = data.durationFormatted || (data.duration ? `${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, "0")}` : "Unknown");
    vIdEl.textContent = data.videoId || extractVideoId(url) || "Unknown";
    if (vUploadDateEl) vUploadDateEl.textContent = data.uploadDateFormatted || data.uploadDate || "Unknown";
    if (vViewsEl) vViewsEl.textContent = data.viewCount != null ? Number(data.viewCount).toLocaleString() : "Unknown";
    if (vLikesEl) vLikesEl.textContent = data.likeCount != null ? Number(data.likeCount).toLocaleString() : "Unknown";
    if (vDescriptionEl) vDescriptionEl.textContent = data.description || "No description";

    if (data.thumbnail) {
      thumbEl.src = data.thumbnail;
      thumbEl.style.display = "block";
    } else {
      thumbEl.removeAttribute("src");
      thumbEl.style.display = "none";
    }

    // Populate quality selector
    qualitySelect.innerHTML = "";
    if (currentFormats.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Best available (no alternatives found)";
      qualitySelect.appendChild(opt);
    } else {
      // Sort desc by height already, but ensure
      currentFormats.sort((a, b) => b.height - a.height);
      for (const f of currentFormats) {
        const opt = document.createElement("option");
        opt.value = f.formatId;
        // Human readable: 720p - mp4 (with audio) + filesize
        const sizeStr = f.filesize ? ` ${formatBytes(f.filesize)}` : "";
        const audioNote = f.hasAudio ? "" : " (merges audio)";
        opt.textContent = `${f.height}p - ${f.ext}${audioNote}${sizeStr}`;
        // Store data for later
        opt.dataset.height = f.height;
        opt.dataset.label = f.label;
        qualitySelect.appendChild(opt);
      }
      // Add "Best" option at top? Keep highest as default (720/1080). The API fallback handles best.
    }

    videoSection.classList.remove("hidden");
    if (intelligenceSection) intelligenceSection.classList.remove("hidden");
    setStatus(statusEl, "Video found. Choose quality and download.", "success");
    // Reset intelligence UI for new video
    if (intelligenceStatusEl) setStatus(intelligenceStatusEl, "", "");
    if (intelligenceContentEl) intelligenceContentEl.classList.add("hidden");
    if (transcriptTextEl) transcriptTextEl.textContent = "";
    if (aiOverviewEl) aiOverviewEl.textContent = "";
    if (aiTopicsEl) aiTopicsEl.innerHTML = "";
    if (aiKeyPointsEl) aiKeyPointsEl.innerHTML = "";
    if (aiProviderEl) aiProviderEl.textContent = "";
    if (aiErrorEl) setStatus(aiErrorEl, "", "");
  } catch (err) {
    setStatus(statusEl, err.message || "An error occurred.", "error");
    videoSection.classList.add("hidden");
    if (intelligenceSection) intelligenceSection.classList.add("hidden");
  } finally {
    getVideoBtn.disabled = false;
    getVideoBtn.textContent = "Get Video";
  }
}

async function getIntelligence() {
  const url = currentUrl || urlInput.value.trim();
  if (!url) {
    setStatus(intelligenceStatusEl, "Please paste a YouTube URL first and fetch video.", "error");
    return;
  }
  if (!isYouTubeUrl(url)) {
    setStatus(intelligenceStatusEl, "Invalid YouTube URL.", "error");
    return;
  }
  setStatus(intelligenceStatusEl, "Generating intelligence (transcript + AI)...", "loading");
  if (intelligenceContentEl) intelligenceContentEl.classList.add("hidden");
  getIntelligenceBtn.disabled = true;
  getIntelligenceBtn.textContent = "Loading...";
  if (aiErrorEl) setStatus(aiErrorEl, "", "");
  try {
    const res = await fetch("/api/intelligence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Intelligence failed");
    // Update expanded info if available (in case user didn't click Get Video)
    if (data.video) {
      if (vUploadDateEl && data.video.uploadDateFormatted) vUploadDateEl.textContent = data.video.uploadDateFormatted;
      if (vViewsEl && data.video.viewCount != null) vViewsEl.textContent = Number(data.video.viewCount).toLocaleString();
      if (vLikesEl && data.video.likeCount != null) vLikesEl.textContent = Number(data.video.likeCount).toLocaleString();
      if (vDescriptionEl && data.video.description) vDescriptionEl.textContent = data.video.description;
    }
    // Show content
    intelligenceContentEl.classList.remove("hidden");
    // Transcript
    if (data.transcript?.available) {
      setStatus(transcriptStatusEl, `Transcript available (${data.transcript.language || "en"}${data.transcript.isAuto ? ", auto" : ", manual"}) — ${data.transcript.text.length} chars`, "success");
      transcriptTextEl.textContent = data.transcript.text.slice(0, 8000) + (data.transcript.text.length > 8000 ? "\n...[truncated]" : "");
    } else {
      setStatus(transcriptStatusEl, data.transcript?.error || "Transcript unavailable", "error");
      transcriptTextEl.textContent = "";
    }
    // About / AI
    if (data.intelligence?.aboutVideo) {
      aiOverviewEl.textContent = data.intelligence.aboutVideo.overview || "—";
      aiTopicsEl.innerHTML = "";
      aiKeyPointsEl.innerHTML = "";
      (data.intelligence.aboutVideo.mainTopics || []).forEach(t => {
        const li = document.createElement("li"); li.textContent = t; aiTopicsEl.appendChild(li);
      });
      (data.intelligence.aboutVideo.keyPoints || []).forEach(k => {
        const li = document.createElement("li"); li.textContent = k; aiKeyPointsEl.appendChild(li);
      });
      aiProviderEl.textContent = `Provider: ${data.intelligence.aboutVideo.provider}${data.intelligence.aboutVideo.isFallback ? " (fallback/mock)" : ""}`;
      setStatus(intelligenceStatusEl, "Intelligence generated", "success");
      if (data.intelligence.aiError) setStatus(aiErrorEl, data.intelligence.aiError, "error");
    } else {
      aiOverviewEl.textContent = "—";
      aiTopicsEl.innerHTML = ""; aiKeyPointsEl.innerHTML = "";
      aiProviderEl.textContent = "";
      setStatus(intelligenceStatusEl, "Intelligence generated (no AI summary)", "success");
      if (data.intelligence?.aiError) setStatus(aiErrorEl, data.intelligence.aiError, "error");
      else if (aiErrorEl) setStatus(aiErrorEl, "AI summary unavailable", "error");
    }
  } catch (err) {
    setStatus(intelligenceStatusEl, err.message || "Intelligence failed", "error");
    if (intelligenceContentEl) intelligenceContentEl.classList.add("hidden");
  } finally {
    getIntelligenceBtn.disabled = false;
    getIntelligenceBtn.textContent = "Get Intelligence";
  }
}

async function downloadVideo() {
  if (!currentUrl) {
    setStatus(downloadStatusEl, "No video selected.", "error");
    return;
  }

  const selectedFormatId = qualitySelect.value || null;

  setStatus(downloadStatusEl, "Starting download... (this may take a moment)", "loading");
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Downloading...";

  try {
    const params = new URLSearchParams({ url: currentUrl });
    if (selectedFormatId) params.set("formatId", selectedFormatId);

    const res = await fetch(`/api/download?${params.toString()}`, {
      method: "GET",
    });

    // Check if error JSON returned (when yt-dlp fails before streaming)
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      // Try to parse error JSON
      if (contentType.includes("application/json")) {
        const errData = await res.json();
        throw new Error(errData.error || `Download failed (${res.status})`);
      } else {
        // Try to get text
        const text = await res.text();
        // If text is JSON-like parse attempt
        try {
          const j = JSON.parse(text);
          throw new Error(j.error || `Download failed (${res.status})`);
        } catch {
          throw new Error(`Download failed (${res.status}). ${text.slice(0, 200)}`);
        }
      }
    }

    // If content-type is JSON but status ok, it means error was sent with 200? shouldn't happen, but handle
    if (contentType.includes("application/json")) {
      const maybeError = await res.json();
      if (maybeError.error) throw new Error(maybeError.error);
      throw new Error("Unexpected response. Expected video file.");
    }

    // Should be video/mp4
    if (!contentType.includes("video") && !contentType.includes("octet-stream")) {
      console.warn("Unexpected content-type:", contentType);
    }

    // Get filename from Content-Disposition if present
    let filename = "video.mp4";
    const disposition = res.headers.get("content-disposition");
    if (disposition) {
      const match = disposition.match(/filename\*?=(?:UTF-8''?)?["']?([^"';\n]+)["']?/i);
      if (match) {
        try {
          filename = decodeURIComponent(match[1].replace(/"/g, ""));
        } catch {
          filename = match[1];
        }
      }
    }

    // Stream to blob (for large files, this loads into memory but keeps complexity low for Phase 1)
    // For true streaming, we could use anchor with direct URL, but fetch gives better error handling.
    // Alternative: window.location = download URL for direct browser handling, but less control.
    const blob = await res.blob();

    if (blob.size === 0) {
      throw new Error("Downloaded file is empty. The requested quality may be unavailable.");
    }

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Delay revoke to allow download start
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    setStatus(downloadStatusEl, `Download started: ${filename} (${(blob.size / (1024*1024)).toFixed(1)} MB)`, "success");
  } catch (err) {
    setStatus(downloadStatusEl, err.message || "Download failed.", "error");
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "Download";
  }
}

// Events
getVideoBtn.addEventListener("click", getVideo);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") getVideo();
});
downloadBtn.addEventListener("click", downloadVideo);
if (getIntelligenceBtn) getIntelligenceBtn.addEventListener("click", getIntelligence);

// Auto-clear status on input
urlInput.addEventListener("input", () => {
  if (statusEl.classList.contains("error")) setStatus(statusEl, "", "");
});
