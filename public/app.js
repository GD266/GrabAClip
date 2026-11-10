// Grab a Clip — frontend logic
import {
  isYouTubeUrl,
  detectPlatform,
  isSupportedMediaUrl,
  normalizeMediaUrl,
  extractMediaId,
} from "/shared/validator.js";

// The API may live on another origin (Vercel frontend + container backend).
// `public/config.js` sets window.GAC_API_BASE; empty means same origin.
const API_BASE = String((typeof window !== "undefined" && window.GAC_API_BASE) || "")
  .trim()
  .replace(/\/+$/, "");

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function apiHint() {
  if (API_BASE) {
    return `Could not reach the downloader API at ${API_BASE}. Check that the backend is running and that CORS allows this origin.`;
  }
  return "No downloader backend is configured for this page. Deploy the backend (see DEPLOY.md) and set GAC_API_BASE to its URL.";
}

async function readApiJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }
  // A static host (or a proxy) answered with HTML/text: the API is missing.
  await response.text().catch(() => "");
  return { error: `Downloader API unavailable (HTTP ${response.status}). ${apiHint()}` };
}

function errorMessage(err, fallback) {
  if (err instanceof TypeError && /fetch|network/i.test(err.message || "")) {
    return `Could not reach the downloader API. ${apiHint()}`;
  }
  return err?.message || fallback;
}

const $ = (id) => document.getElementById(id);

// Hero
const urlInput = $("urlInput");
const getVideoBtn = $("getVideoBtn");
const statusEl = $("status");
const inputShellEl = $("inputShell");

// Result
const resultArea = $("resultArea");
const thumbEl = $("thumb");
const thumbFallbackEl = $("thumbFallback");
const vTitleEl = $("vTitle");
const vChannelEl = $("vChannel");
const vDurationEl = $("vDuration");
const vIdKickerEl = $("vIdKicker");
const vUploadDateEl = $("vUploadDate");
const vViewsEl = $("vViews");
const vLikesEl = $("vLikes");
const vQualityCountEl = $("vQualityCount");
const vDescriptionEl = $("vDescription");

// Tabs
const tabs = {
  video: $("tabVideo"),
  audio: $("tabAudio"),
  images: $("tabImages"),
  intel: $("tabIntel"),
};
const panels = {
  video: $("panelVideo"),
  audio: $("panelAudio"),
  images: $("panelImages"),
  intel: $("panelIntel"),
};

// Video panel
const qualityGridEl = $("qualityGrid");
const videoSourceNoteEl = $("videoSourceNote");
const downloadBtn = $("downloadBtn");
const cancelVideoBtn = $("cancelVideoBtn");
const videoProgressEl = $("videoProgress");
const downloadStatusEl = $("downloadStatus");
const smallFileToggle = $("smallFileToggle");
const sizeToggleRowEl = $("sizeToggleRow");

// Audio panel
const audioOptionsEl = $("audioOptions");
const audioSourceNoteEl = $("audioSourceNote");
const downloadAudioBtn = $("downloadAudioBtn");
const cancelAudioBtn = $("cancelAudioBtn");
const audioProgressEl = $("audioProgress");
const audioStatusEl = $("audioStatus");

// Images panel
const imageGalleryEl = $("imageGallery");
const imageBadgeEl = $("imageBadge");
const imageSourceNoteEl = $("imageSourceNote");
const downloadAllImagesBtn = $("downloadAllImagesBtn");
const cancelImagesBtn = $("cancelImagesBtn");
const imageProgressEl = $("imageProgress");
const imageStatusEl = $("imageStatus");

// Intelligence panel
const getIntelligenceBtn = $("getIntelligenceBtn");
const intelligenceStatusEl = $("intelligenceStatus");
const intelligenceContentEl = $("intelligenceContent");
const transcriptStatusEl = $("transcriptStatus");
const transcriptTextEl = $("transcriptText");
const aiOverviewEl = $("aiOverview");
const aiTopicsEl = $("aiTopics");
const aiKeyPointsEl = $("aiKeyPoints");
const aiProviderEl = $("aiProvider");
const aiErrorEl = $("aiError");

// State
let currentUrl = "";
let currentInfo = null;
let currentPlatform = null;
let currentMediaType = "video";
let selectedHeight = null;
let selectedAudio = null;
const downloads = {
  video: { active: false, controller: null, poll: null },
  audio: { active: false, controller: null, poll: null },
  image: { active: false, controller: null, poll: null },
};

const PLATFORM_NAMES = {
  youtube: "YouTube",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
};

const PHASE_LABELS = {
  preparing: "Preparing…",
  fetching: "Fetching video info…",
  processing: "Processing…",
  downloading: "Downloading…",
  complete: "Complete",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(el, message, type = "") {
  if (!el) return;
  el.textContent = message;
  const base = el.dataset.baseClass || "status";
  el.className = base + (type ? ` ${type}` : "");
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `~${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `~${mb.toFixed(1)} MB`;
  return `~${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatBytesProgress(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function setProgress(el, received, total) {
  if (!el) return;
  const fill = el.querySelector(".progress-fill");
  if (!fill) return;
  if (total && total > 0) {
    const pct = Math.min(100, (received / total) * 100);
    el.classList.remove("indeterminate");
    fill.style.width = `${pct.toFixed(1)}%`;
  } else {
    el.classList.add("indeterminate");
    fill.style.width = "";
  }
}

function setProgressPercent(el, pct) {
  if (!el) return;
  const fill = el.querySelector(".progress-fill");
  if (!fill) return;
  el.classList.remove("indeterminate");
  fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

function showIndeterminateProgress(el) {
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.add("indeterminate");
  const fill = el.querySelector(".progress-fill");
  if (fill) fill.style.width = "";
}

function resetProgress(el) {
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("indeterminate");
  const fill = el.querySelector(".progress-fill");
  if (fill) fill.style.width = "0%";
}

function showProgress(el) {
  if (el) el.classList.remove("hidden");
}

function activateTab(name) {
  for (const key of Object.keys(tabs)) {
    const isActive = key === name;
    tabs[key].classList.toggle("is-active", isActive);
    tabs[key].setAttribute("aria-selected", String(isActive));
    panels[key].classList.toggle("hidden", !isActive);
  }
}

function setIntelligenceAvailability(platform) {
  const available = platform === "youtube";
  tabs.intel.classList.toggle("hidden", !available);
  if (!available && tabs.intel.classList.contains("is-active")) activateTab("video");
}

function setMediaAvailability(platform, mediaType) {
  const isVideo = mediaType === "video";
  tabs.video.classList.toggle("hidden", !isVideo);
  tabs.audio.classList.toggle("hidden", !isVideo);
  tabs.images.classList.toggle("hidden", isVideo);
  setIntelligenceAvailability(platform);

  if (!isVideo && (tabs.video.classList.contains("is-active") || tabs.audio.classList.contains("is-active"))) {
    activateTab("images");
  } else if (isVideo && tabs.images.classList.contains("is-active")) {
    activateTab("video");
  }
}

function isImageMedia() {
  return currentMediaType === "image" || currentMediaType === "gallery";
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

async function getVideo() {
  const url = urlInput.value.trim();

  if (!url) {
    setStatus(statusEl, "Please paste a YouTube, X, Instagram, or Facebook link.", "error");
    return;
  }
  if (!isSupportedMediaUrl(url)) {
    setStatus(
      statusEl,
      "Unsupported link. Use a YouTube video, X post, Instagram reel/post, or public Facebook video/photo URL.",
      "error"
    );
    return;
  }

  // The server always works with the canonical URL (status entries, de-dupe).
  // Normalise here too, otherwise progress polling can never match the job
  // (youtu.be links, mobile links, &t=/&list= parameters, X /video/N, ...).
  const normalizedUrl = normalizeMediaUrl(url) || url;
  const requestedPlatform = detectPlatform(normalizedUrl);

  setStatus(statusEl, "Fetching media information…", "loading");
  getVideoBtn.disabled = true;
  const label = getVideoBtn.querySelector(".btn-label");
  const spinner = getVideoBtn.querySelector(".btn-spinner");
  if (label) label.textContent = "Loading…";
  if (spinner) spinner.classList.remove("hidden");
  if (inputShellEl) inputShellEl.style.opacity = "0.85";
  resultArea.classList.add("hidden");

  try {
    const res = await fetch(apiUrl("/api/info"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalizedUrl }),
    });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || `Failed to retrieve media information. ${apiHint()}`);

    currentUrl = normalizedUrl;
    currentInfo = data;
    currentPlatform = data.platform || requestedPlatform || null;
    currentMediaType = data.mediaType || "video";
    const imageMedia = isImageMedia();
    const images = Array.isArray(data.images) ? data.images : [];
    const imageCount = data.imageCount || images.length;

    vTitleEl.textContent = data.title || "Untitled";
    vChannelEl.textContent = data.channel || "Unknown";
    vDurationEl.textContent = imageMedia
      ? `${imageCount} ${imageCount === 1 ? "image" : "images"}`
      : data.durationFormatted ||
        (data.duration ? `${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, "0")}` : "Unknown");
    const platformName = PLATFORM_NAMES[currentPlatform] || "";
    vIdKickerEl.textContent = data.videoId
      ? `${platformName ? `${platformName} · ` : ""}ID ${data.videoId}`
      : platformName;
    vUploadDateEl.textContent = data.uploadDateFormatted || data.uploadDate || "Unknown";
    vViewsEl.textContent = data.viewCount != null ? Number(data.viewCount).toLocaleString() : "Unknown";
    vLikesEl.textContent = data.likeCount != null ? Number(data.likeCount).toLocaleString() : "Unknown";
    vQualityCountEl.textContent = imageMedia
      ? `${imageCount} ${imageCount === 1 ? "image" : "images"}`
      : (data.formats || []).length
        ? `${(data.formats || []).length} video · ${(data.audioFormats || []).length} audio`
        : "—";
    vDescriptionEl.textContent = data.description || (imageMedia ? "Public Facebook image post" : "No description");

    if (data.thumbnail) {
      thumbEl.src = data.thumbnail;
      thumbEl.style.display = "block";
      thumbFallbackEl.classList.add("hidden");
      thumbEl.onload = () => thumbFallbackEl.classList.add("hidden");
      thumbEl.onerror = () => {
        thumbEl.style.display = "none";
        thumbFallbackEl.classList.remove("hidden");
      };
    } else if (imageMedia && images.length > 0) {
      thumbEl.src = imageProxyUrl(0);
      thumbEl.style.display = "block";
      thumbFallbackEl.classList.add("hidden");
      thumbEl.onload = () => thumbFallbackEl.classList.add("hidden");
      thumbEl.onerror = () => {
        thumbEl.style.display = "none";
        thumbFallbackEl.classList.remove("hidden");
      };
    } else {
      thumbEl.removeAttribute("src");
      thumbEl.style.display = "none";
      thumbFallbackEl.classList.remove("hidden");
    }

    // The H.264 compatibility choice only exists for YouTube's plan sets.
    if (sizeToggleRowEl) sizeToggleRowEl.classList.toggle("hidden", currentPlatform !== "youtube" || imageMedia);
    setMediaAvailability(currentPlatform, currentMediaType);

    renderVideoOptions(imageMedia ? [] : videoFormatsForUi());
    renderAudioOptions(imageMedia ? [] : data.audioFormats || [], imageMedia ? null : data.audioSource || null);
    renderImages(images);

    // Reset download UI for the new media item.
    resetProgress(videoProgressEl);
    resetProgress(audioProgressEl);
    resetProgress(imageProgressEl);
    setStatus(downloadStatusEl, "", "");
    setStatus(audioStatusEl, "", "");
    setStatus(imageStatusEl, "", "");
    setStatus(intelligenceStatusEl, "", "");
    intelligenceContentEl.classList.add("hidden");
    transcriptTextEl.textContent = "";
    aiOverviewEl.textContent = "";
    aiTopicsEl.innerHTML = "";
    aiKeyPointsEl.innerHTML = "";
    aiProviderEl.textContent = "";
    setStatus(aiErrorEl, "", "");

    resultArea.classList.remove("hidden");
    activateTab(imageMedia ? "images" : "video");
    setStatus(
      statusEl,
      imageMedia
        ? "Images ready. Download one or the whole gallery."
        : "Media ready. Pick a quality and download.",
      "success"
    );
  } catch (err) {
    setStatus(statusEl, errorMessage(err, "An error occurred."), "error");
    resultArea.classList.add("hidden");
  } finally {
    getVideoBtn.disabled = false;
    const label2 = getVideoBtn.querySelector(".btn-label");
    const spinner2 = getVideoBtn.querySelector(".btn-spinner");
    if (label2) label2.textContent = "Get media";
    if (spinner2) spinner2.classList.add("hidden");
    if (inputShellEl) inputShellEl.style.opacity = "";
  }
}

// ---------------------------------------------------------------------------
// Option grids
// ---------------------------------------------------------------------------

function sourceLabel(plan) {
  if (!plan) return "";
  if (plan.hasAudio === false || plan.kind === "video") return "Video only";
  if (plan.kind === "muxed") return plan.source === "progressive" ? "Single file" : "HLS stream";
  if (plan.kind === "merge") return "Video + audio merge";
  return "Single file";
}

/**
 * Plan set for the current size preference: the server returns size-optimised
 * plans (AV1/VP9) as `formats` and H.264 plans as `formatsCompatible`.
 */
function videoFormatsForUi() {
  const info = currentInfo;
  if (!info) return [];
  const sizePlans = Array.isArray(info.formats) ? info.formats : [];
  const compatPlans = Array.isArray(info.formatsCompatible) ? info.formatsCompatible : [];
  if (smallFileToggle && !smallFileToggle.checked) return compatPlans.length ? compatPlans : sizePlans;
  return sizePlans.length ? sizePlans : compatPlans;
}

function refreshVideoOptions() {
  if (!currentInfo || downloads.video.active) return;
  const previous = selectedHeight;
  const formats = videoFormatsForUi();
  renderVideoOptions(formats);
  if (previous != null && formats.some((f) => f.height === previous)) selectVideoOption(previous);
}

function renderVideoOptions(formats) {
  qualityGridEl.innerHTML = "";
  if (!formats.length) {
    selectedHeight = null;
    const empty = document.createElement("p");
    empty.className = "option-note";
    empty.textContent = "No downloadable video qualities were found for this link.";
    qualityGridEl.appendChild(empty);
    videoSourceNoteEl.textContent = "";
    downloadBtn.disabled = true;
    return;
  }
  downloadBtn.disabled = false;
  selectedHeight = formats[0].height;

  for (const f of formats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.setAttribute("role", "radio");
    btn.dataset.height = String(f.height);

    const label = document.createElement("span");
    label.className = "opt-label";
    label.textContent = f.label;

    const note = document.createElement("span");
    note.className = "opt-note";
    const bits = [];
    if (f.estimatedSize) bits.push(formatBytes(f.estimatedSize));
    if (f.codecLabel) bits.push(f.codecLabel);
    bits.push(sourceLabel(f));
    note.textContent = bits.filter(Boolean).join(" · ");

    btn.append(label, note);
    btn.addEventListener("click", () => selectVideoOption(f.height));
    qualityGridEl.appendChild(btn);
  }
  selectVideoOption(selectedHeight);
}

function selectVideoOption(height) {
  selectedHeight = height;
  for (const btn of qualityGridEl.querySelectorAll(".opt")) {
    const isSelected = Number(btn.dataset.height) === height;
    btn.classList.toggle("is-selected", isSelected);
    btn.setAttribute("aria-checked", String(isSelected));
  }
  const plan = videoFormatsForUi().find((f) => f.height === height);
  if (plan) {
    const size = plan.estimatedSize ? ` · approx. ${formatBytes(plan.estimatedSize)}` : "";
    const codec = plan.codecLabel ? ` · ${plan.codecLabel}` : "";
    const audio = plan.hasAudio === false ? "no audio track" : "includes audio";
    videoSourceNoteEl.textContent = `${plan.label}${codec} · ${sourceLabel(plan)} · ${audio}${size}`;
  } else {
    videoSourceNoteEl.textContent = "";
  }
}

function renderAudioOptions(options, audioSource) {
  audioOptionsEl.innerHTML = "";
  if (!options.length) {
    selectedAudio = null;
    downloadAudioBtn.disabled = true;
    const empty = document.createElement("p");
    empty.className = "option-note";
    empty.textContent = "No audio track was found for this link.";
    audioOptionsEl.appendChild(empty);
    audioSourceNoteEl.textContent = "";
    return;
  }
  downloadAudioBtn.disabled = false;
  const preferred = options.find((o) => o.id === "m4a") || options[0];
  selectedAudio = { id: preferred.id, quality: preferred.quality ?? null };

  for (const option of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.setAttribute("role", "radio");
    btn.dataset.format = option.id;
    btn.dataset.quality = option.quality ?? "";

    const label = document.createElement("span");
    label.className = "opt-label";
    label.textContent = option.label || option.displayLabel || option.id;

    const note = document.createElement("span");
    note.className = "opt-note";
    note.textContent = option.note || "";

    btn.append(label, note);
    btn.addEventListener("click", () => selectAudioOption(option));
    audioOptionsEl.appendChild(btn);
  }
  selectAudioOption(preferred, audioSource);
}

function selectAudioOption(option, audioSource = null) {
  selectedAudio = { id: option.id, quality: option.quality ?? null };
  for (const btn of audioOptionsEl.querySelectorAll(".opt")) {
    const isSelected = btn.dataset.format === option.id && (btn.dataset.quality || "") === String(option.quality ?? "");
    btn.classList.toggle("is-selected", isSelected);
    btn.setAttribute("aria-checked", String(isSelected));
  }
  const source = audioSource || currentInfo?.audioSource;
  const parts = [];
  if (source?.label) parts.push(`Source: ${source.label}`);
  parts.push(option.note || "");
  audioSourceNoteEl.textContent = parts.filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Image gallery
// ---------------------------------------------------------------------------

function imageProxyUrl(index) {
  const params = new URLSearchParams({ url: currentUrl, index: String(index) });
  return apiUrl(`/api/image?${params.toString()}`);
}

function imageDownloadUrl(index) {
  const params = new URLSearchParams({ url: currentUrl, index: String(index) });
  return apiUrl(`/api/download/image?${params.toString()}`);
}

function renderImages(images) {
  if (!imageGalleryEl) return;
  imageGalleryEl.innerHTML = "";
  const count = Array.isArray(images) ? images.length : 0;
  if (imageBadgeEl) imageBadgeEl.textContent = `${count} ${count === 1 ? "image" : "images"}`;

  if (count === 0) {
    if (downloadAllImagesBtn) downloadAllImagesBtn.disabled = true;
    if (imageSourceNoteEl) imageSourceNoteEl.textContent = "";
    return;
  }

  if (downloadAllImagesBtn) downloadAllImagesBtn.disabled = false;
  if (imageSourceNoteEl) {
    imageSourceNoteEl.textContent =
      count === 1
        ? "Public Facebook image. Download it below."
        : `Public Facebook gallery · ${count} images. Download individually or save all as a ZIP.`;
  }

  images.forEach((image, index) => {
    const card = document.createElement("div");
    card.className = "image-card";
    card.setAttribute("role", "listitem");

    const link = document.createElement("a");
    link.className = "image-thumb-link";
    link.href = imageProxyUrl(index);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `Open image ${index + 1}`;

    const img = document.createElement("img");
    img.className = "image-thumb";
    img.src = imageProxyUrl(index);
    img.alt = `Facebook image ${index + 1}`;
    img.loading = "lazy";
    img.decoding = "async";
    if (image.width && image.height) {
      img.width = image.width;
      img.height = image.height;
    }
    link.appendChild(img);

    const footer = document.createElement("div");
    footer.className = "image-card-footer";

    const meta = document.createElement("span");
    meta.className = "image-card-meta";
    const dimensions = image.width && image.height ? `${image.width}×${image.height}` : "Facebook image";
    meta.textContent = `Image ${index + 1} · ${dimensions}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary btn-sm";
    btn.textContent = "Download";
    btn.addEventListener("click", () => downloadImage(index, btn));

    footer.append(meta, btn);
    card.append(link, footer);
    imageGalleryEl.appendChild(card);
  });
}

function setImageDownloading(isDownloading) {
  downloads.image.active = isDownloading;
  if (downloadAllImagesBtn) downloadAllImagesBtn.disabled = isDownloading;
  if (cancelImagesBtn) cancelImagesBtn.classList.toggle("hidden", !isDownloading);
  for (const btn of imageGalleryEl.querySelectorAll("button")) btn.disabled = isDownloading;
  if (downloadAllImagesBtn) {
    downloadAllImagesBtn.textContent = isDownloading ? "Preparing download…" : "Download all as ZIP";
  }
}

function cancelImageDownload() {
  const state = downloads.image;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  setImageDownloading(false);
  resetProgress(imageProgressEl);
  setStatus(imageStatusEl, "Image download cancelled.", "error");
}

function downloadImage(index, button = null) {
  if (!currentUrl || downloads.image.active) return;
  const label = button?.textContent;
  if (button) button.textContent = "Downloading…";
  setImageDownloading(true);
  resetProgress(imageProgressEl);
  showIndeterminateProgress(imageProgressEl);
  setStatus(imageStatusEl, "Downloading image…", "loading");

  downloadWithProgress(
    imageDownloadUrl(index),
    { statusEl: imageStatusEl, progressEl: imageProgressEl },
    (received, total) => {
      if (total) {
        const pct = Math.round((received / total) * 100);
        setStatus(imageStatusEl, `Downloading image… ${formatBytesProgress(received)} / ${formatBytesProgress(total)} (${pct}%)`, "loading");
      } else {
        setStatus(imageStatusEl, `Downloading image… ${formatBytesProgress(received)}`, "loading");
      }
    },
    "image"
  )
    .then(({ blob, filename }) => {
      if (blob.size === 0) throw new Error("Downloaded image is empty.");
      saveBlob(blob, filename || `facebook-image-${index + 1}.jpg`);
      setStatus(imageStatusEl, `Complete: ${filename || `image ${index + 1}`} (${formatBytesProgress(blob.size)})`, "success");
    })
    .catch((err) => {
      if (err.name === "AbortError") setStatus(imageStatusEl, "Image download cancelled.", "error");
      else setStatus(imageStatusEl, errorMessage(err, "Image download failed."), "error");
    })
    .finally(() => {
      resetProgress(imageProgressEl);
      setImageDownloading(false);
      if (button) button.textContent = label || "Download";
    });
}

function downloadAllImages() {
  if (!currentUrl || downloads.image.active) return;
  setImageDownloading(true);
  resetProgress(imageProgressEl);
  showIndeterminateProgress(imageProgressEl);
  setStatus(imageStatusEl, "Packaging image gallery…", "loading");

  const params = new URLSearchParams({ url: currentUrl });
  downloadWithProgress(
    apiUrl(`/api/download/images?${params.toString()}`),
    { statusEl: imageStatusEl, progressEl: imageProgressEl },
    (received, total) => {
      if (total) {
        const pct = Math.round((received / total) * 100);
        setStatus(imageStatusEl, `Downloading ZIP… ${formatBytesProgress(received)} / ${formatBytesProgress(total)} (${pct}%)`, "loading");
      } else {
        setStatus(imageStatusEl, `Downloading ZIP… ${formatBytesProgress(received)}`, "loading");
      }
    },
    "image"
  )
    .then(({ blob, filename }) => {
      if (blob.size === 0) throw new Error("Downloaded ZIP is empty.");
      saveBlob(blob, filename || "facebook-images.zip");
      setStatus(imageStatusEl, `Complete: ${filename || "facebook-images.zip"} (${formatBytesProgress(blob.size)})`, "success");
    })
    .catch((err) => {
      if (err.name === "AbortError") setStatus(imageStatusEl, "Image download cancelled.", "error");
      else setStatus(imageStatusEl, errorMessage(err, "Image gallery download failed."), "error");
    })
    .finally(() => {
      resetProgress(imageProgressEl);
      setImageDownloading(false);
    });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function downloadWithProgress(url, { statusEl: statusTarget, progressEl }, onProgress, stateKey = null) {
  const controller = new AbortController();
  const key = stateKey || (url.includes("/audio") ? "audio" : "video");
  const state = downloads[key];
  state.controller = controller;

  return fetch(url, { signal: controller.signal }).then(async (response) => {
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = `Download failed (${response.status}).`;
      if (contentType.includes("application/json")) {
        const errData = await response.json().catch(() => ({}));
        message = errData.error || message;
      } else {
        await response.text().catch(() => {});
        message = `${message} ${apiHint()}`;
      }
      throw new Error(message);
    }

    if (contentType.includes("application/json")) {
      const maybeError = await response.json().catch(() => ({}));
      throw new Error(maybeError.error || "Unexpected response. Expected a file.");
    }

    let filename = null;
    const disposition = response.headers.get("content-disposition");
    if (disposition) {
      const match = disposition.match(/filename\*?=(?:UTF-8''?)?["']?([^"';\n]+)["']?/i);
      if (match) {
        try { filename = decodeURIComponent(match[1].replace(/"/g, "")); } catch { filename = match[1]; }
      }
    }

    const totalHeader = response.headers.get("content-length") || response.headers.get("x-expected-size");
    const total = totalHeader ? parseInt(totalHeader, 10) : null;

    showProgress(progressEl);
    if (total) setProgress(progressEl, 0, total);

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastUpdate = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const now = Date.now();
      if (now - lastUpdate > 150 || received === total) {
        lastUpdate = now;
        setProgress(progressEl, received, total);
        if (onProgress) onProgress(received, total);
      }
    }

    const blob = new Blob(chunks, { type: contentType || "application/octet-stream" });
    if (!filename) {
      const ct = contentType.includes("video") ? "video.mp4" : contentType.includes("audio") ? "audio.m4a" : "download";
      filename = ct;
    }
    return { blob, filename, total, received };
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function formatEta(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startPhasePolling(type, url, statusTarget, progressEl, estimatedBytes = null) {
  stopPhasePolling(type);
  const state = downloads[type];
  const wantedId = extractMediaId(url);
  let lastPct = null;
  let lastAt = Date.now();

  state.poll = setInterval(async () => {
    try {
      const res = await fetch(apiUrl("/api/downloads/status"));
      if (!res.ok) return;
      const data = await res.json();
      // Match on the canonical URL, falling back to the platform media id so
      // the job is found even if the page holds a different URL shape.
      const entry = (data.downloads || []).find(
        (d) => d.type === type && (d.url === url || (wantedId && extractMediaId(d.url) === wantedId))
      );
      if (!entry) return;
      if (receivedBytes[type]) return; // byte progress has taken over
      if (entry.phase === "failed") {
        setStatus(statusTarget, entry.error || "Download failed.", "error");
        return;
      }
      if (entry.phase === "complete") return;

      const detail = entry.detail || PHASE_LABELS[entry.phase] || entry.phase;
      if (entry.phase === "processing") {
        const pct = typeof entry.progress === "number" ? entry.progress : 0;
        if (pct > 0) {
          showProgress(progressEl);
          setProgressPercent(progressEl, pct);
        }

        // Speed / ETA from progress deltas (size estimate comes from the plan).
        let meta = "";
        const now = Date.now();
        if (pct > 0 && estimatedBytes && lastPct != null && pct > lastPct) {
          const dt = (now - lastAt) / 1000;
          if (dt > 0.3) {
            const speed = (((pct - lastPct) / 100) * estimatedBytes) / dt;
            if (speed > 0) {
              meta = ` · ${formatBytesProgress(speed)}/s`;
              const remaining = (((100 - pct) / 100) * estimatedBytes) / speed;
              if (remaining > 1 && remaining < 7200) meta += ` · ~${formatEta(remaining)} left`;
            }
            lastPct = pct;
            lastAt = now;
          }
        } else if (pct > 0 && lastPct == null) {
          lastPct = pct;
          lastAt = now;
        }

        setStatus(statusTarget, `${detail}${meta}`, "loading");
      } else {
        setStatus(statusTarget, PHASE_LABELS[entry.phase] || entry.phase, "loading");
      }
    } catch {}
  }, 600);
}

function stopPhasePolling(type) {
  const state = downloads[type];
  if (state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
}

const receivedBytes = { video: 0, audio: 0 };

function setDownloading(type, isDownloading) {
  const state = downloads[type];
  state.active = isDownloading;
  const btn = type === "video" ? downloadBtn : downloadAudioBtn;
  const cancel = type === "video" ? cancelVideoBtn : cancelAudioBtn;
  const list = type === "video" ? qualityGridEl : audioOptionsEl;
  const otherBtn = type === "video" ? downloadAudioBtn : downloadBtn;
  const otherList = type === "video" ? audioOptionsEl : qualityGridEl;

  btn.disabled = isDownloading;
  otherBtn.disabled = isDownloading;
  cancel.classList.toggle("hidden", !isDownloading);
  for (const el of list.querySelectorAll(".opt")) el.disabled = isDownloading;
  for (const el of otherList.querySelectorAll(".opt")) el.disabled = isDownloading;
  btn.textContent = isDownloading ? "Downloading…" : type === "video" ? "Download video" : "Download audio";
}

function cancelDownload(type) {
  const state = downloads[type];
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  stopPhasePolling(type);
  setDownloading(type, false);
  resetProgress(type === "video" ? videoProgressEl : audioProgressEl);
  setStatus(type === "video" ? downloadStatusEl : audioStatusEl, "Download cancelled.", "error");
}

async function downloadVideo() {
  if (downloads.video.active) return;
  if (!currentUrl) {
    setStatus(downloadStatusEl, "No video selected. Fetch a video first.", "error");
    return;
  }
  if (selectedHeight == null) {
    setStatus(downloadStatusEl, "No quality available to download.", "error");
    return;
  }

  const params = new URLSearchParams({ url: currentUrl, height: String(selectedHeight) });
  // The default plan set is the smaller AV1/VP9 one; unchecking the box asks
  // the server for the H.264 plans instead.
  params.set("codec", smallFileToggle && !smallFileToggle.checked ? "h264" : "small");
  const downloadUrl = apiUrl(`/api/download?${params.toString()}`);

  setDownloading("video", true);
  resetProgress(videoProgressEl);
  showIndeterminateProgress(videoProgressEl);
  receivedBytes.video = 0;
  setStatus(downloadStatusEl, "Starting download…", "loading");
  const videoPlan = videoFormatsForUi().find((f) => f.height === selectedHeight);
  startPhasePolling("video", currentUrl, downloadStatusEl, videoProgressEl, videoPlan?.estimatedSize || null);

  try {
    const { blob, filename } = await downloadWithProgress(
      downloadUrl,
      { statusEl: downloadStatusEl, progressEl: videoProgressEl },
      (received, total) => {
        receivedBytes.video = received;
        stopPhasePolling("video");
        if (total) {
          const pct = Math.round((received / total) * 100);
          setStatus(downloadStatusEl, `Downloading… ${formatBytesProgress(received)} / ${formatBytesProgress(total)} (${pct}%)`, "loading");
        } else {
          setStatus(downloadStatusEl, `Downloading… ${formatBytesProgress(received)}`, "loading");
        }
      }
    );
    if (blob.size === 0) throw new Error("Downloaded file is empty. Try another quality.");
    saveBlob(blob, filename || "video.mp4");
    setStatus(downloadStatusEl, `Complete: ${filename} (${formatBytesProgress(blob.size)})`, "success");
  } catch (err) {
    if (err.name === "AbortError") setStatus(downloadStatusEl, "Download cancelled.", "error");
    else setStatus(downloadStatusEl, errorMessage(err, "Download failed."), "error");
  } finally {
    stopPhasePolling("video");
    receivedBytes.video = 0;
    setDownloading("video", false);
  }
}

async function downloadAudio() {
  if (downloads.audio.active) return;
  if (!currentUrl) {
    setStatus(audioStatusEl, "No video selected. Fetch a video first.", "error");
    return;
  }
  if (!selectedAudio) {
    setStatus(audioStatusEl, "No audio format available.", "error");
    return;
  }

  const params = new URLSearchParams({ url: currentUrl, format: selectedAudio.id });
  if (selectedAudio.quality != null) params.set("quality", String(selectedAudio.quality));
  const downloadUrl = apiUrl(`/api/download/audio?${params.toString()}`);

  setDownloading("audio", true);
  resetProgress(audioProgressEl);
  showIndeterminateProgress(audioProgressEl);
  receivedBytes.audio = 0;
  setStatus(audioStatusEl, "Starting audio download…", "loading");
  startPhasePolling("audio", currentUrl, audioStatusEl, audioProgressEl);

  try {
    const { blob, filename } = await downloadWithProgress(
      downloadUrl,
      { statusEl: audioStatusEl, progressEl: audioProgressEl },
      (received, total) => {
        receivedBytes.audio = received;
        stopPhasePolling("audio");
        if (total) {
          const pct = Math.round((received / total) * 100);
          setStatus(audioStatusEl, `Downloading… ${formatBytesProgress(received)} / ${formatBytesProgress(total)} (${pct}%)`, "loading");
        } else {
          setStatus(audioStatusEl, `Downloading… ${formatBytesProgress(received)}`, "loading");
        }
      }
    );
    if (blob.size === 0) throw new Error("Downloaded audio is empty. Try another format.");
    saveBlob(blob, filename || "audio.m4a");
    setStatus(audioStatusEl, `Complete: ${filename} (${formatBytesProgress(blob.size)})`, "success");
  } catch (err) {
    if (err.name === "AbortError") setStatus(audioStatusEl, "Audio download cancelled.", "error");
    else setStatus(audioStatusEl, errorMessage(err, "Audio download failed."), "error");
  } finally {
    stopPhasePolling("audio");
    receivedBytes.audio = 0;
    setDownloading("audio", false);
  }
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

async function getIntelligence() {
  const url = currentUrl || urlInput.value.trim();
  if (!url) {
    setStatus(intelligenceStatusEl, "Fetch a video first.", "error");
    return;
  }
  if (!isYouTubeUrl(url)) {
    setStatus(intelligenceStatusEl, "Intelligence is available for YouTube links only.", "error");
    return;
  }

  setStatus(intelligenceStatusEl, "Generating intelligence (transcript + AI)…", "loading");
  intelligenceContentEl.classList.add("hidden");
  getIntelligenceBtn.disabled = true;
  getIntelligenceBtn.textContent = "Loading…";
  setStatus(aiErrorEl, "", "");

  try {
    const res = await fetch(apiUrl("/api/intelligence"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || `Intelligence failed. ${apiHint()}`);

    if (data.video) {
      if (data.video.uploadDateFormatted) vUploadDateEl.textContent = data.video.uploadDateFormatted;
      if (data.video.viewCount != null) vViewsEl.textContent = Number(data.video.viewCount).toLocaleString();
      if (data.video.likeCount != null) vLikesEl.textContent = Number(data.video.likeCount).toLocaleString();
      if (data.video.description) vDescriptionEl.textContent = data.video.description;
    }

    intelligenceContentEl.classList.remove("hidden");

    if (data.transcript?.available) {
      const meta = `${data.transcript.language || "en"}${data.transcript.isAuto ? ", auto" : ", manual"}`;
      setStatus(transcriptStatusEl, `Transcript available (${meta}) — ${data.transcript.text.length.toLocaleString()} chars`, "success");
      transcriptTextEl.textContent =
        data.transcript.text.slice(0, 8000) + (data.transcript.text.length > 8000 ? "\n…[truncated]" : "");
    } else {
      setStatus(transcriptStatusEl, data.transcript?.error || "Transcript unavailable", "error");
      transcriptTextEl.textContent = "";
    }

    if (data.intelligence?.aboutVideo) {
      aiOverviewEl.textContent = data.intelligence.aboutVideo.overview || "—";
      aiTopicsEl.innerHTML = "";
      aiKeyPointsEl.innerHTML = "";
      for (const topic of data.intelligence.aboutVideo.mainTopics || []) {
        const li = document.createElement("li");
        li.textContent = topic;
        aiTopicsEl.appendChild(li);
      }
      for (const point of data.intelligence.aboutVideo.keyPoints || []) {
        const li = document.createElement("li");
        li.textContent = point;
        aiKeyPointsEl.appendChild(li);
      }
      aiProviderEl.textContent = `Provider: ${data.intelligence.aboutVideo.provider}${data.intelligence.aboutVideo.isFallback ? " (fallback/mock)" : ""}`;
      setStatus(intelligenceStatusEl, "Intelligence generated.", "success");
      if (data.intelligence.aiError) setStatus(aiErrorEl, data.intelligence.aiError, "error");
    } else {
      aiOverviewEl.textContent = "—";
      aiTopicsEl.innerHTML = "";
      aiKeyPointsEl.innerHTML = "";
      aiProviderEl.textContent = "";
      setStatus(intelligenceStatusEl, "Intelligence generated (no AI summary).", "success");
      if (data.intelligence?.aiError) setStatus(aiErrorEl, data.intelligence.aiError, "error");
    }
  } catch (err) {
    setStatus(intelligenceStatusEl, errorMessage(err, "Intelligence failed."), "error");
    intelligenceContentEl.classList.add("hidden");
  } finally {
    getIntelligenceBtn.disabled = false;
    getIntelligenceBtn.textContent = "Get intelligence";
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

getVideoBtn.addEventListener("click", getVideo);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") getVideo();
});
urlInput.addEventListener("input", () => {
  if (statusEl.classList.contains("error")) setStatus(statusEl, "", "");
});

tabs.video.addEventListener("click", () => activateTab("video"));
tabs.audio.addEventListener("click", () => activateTab("audio"));
tabs.images.addEventListener("click", () => activateTab("images"));
tabs.intel.addEventListener("click", () => activateTab("intel"));

downloadBtn.addEventListener("click", downloadVideo);
downloadAudioBtn.addEventListener("click", downloadAudio);
if (smallFileToggle) smallFileToggle.addEventListener("change", refreshVideoOptions);
cancelVideoBtn.addEventListener("click", () => cancelDownload("video"));
cancelAudioBtn.addEventListener("click", () => cancelDownload("audio"));
if (downloadAllImagesBtn) downloadAllImagesBtn.addEventListener("click", downloadAllImages);
if (cancelImagesBtn) cancelImagesBtn.addEventListener("click", cancelImageDownload);
getIntelligenceBtn.addEventListener("click", getIntelligence);

// A Vercel/static deployment has no API on its own. Probe the status endpoint
// (cheap, no yt-dlp spawn) and explain the missing backend instead of failing
// silently on the first "Get video" click.
async function checkApiAvailability() {
  try {
    const res = await fetch(apiUrl("/api/downloads/status"));
    const contentType = res.headers.get("content-type") || "";
    // Static hosts often answer unknown paths with index.html (200), not 404.
    if (res.status === 404 || !contentType.includes("application/json")) {
      setStatus(statusEl, apiHint(), "error");
    }
  } catch {
    // Offline / cold start: the user sees a network error when they submit.
  }
}
checkApiAvailability();
