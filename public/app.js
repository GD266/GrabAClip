// Grab a Clip — frontend logic
import { isYouTubeUrl, extractVideoId, normalizeYouTubeUrl } from "/shared/validator.js";

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
const tabs = { video: $("tabVideo"), audio: $("tabAudio"), intel: $("tabIntel") };
const panels = { video: $("panelVideo"), audio: $("panelAudio"), intel: $("panelIntel") };

// Video panel
const qualityGridEl = $("qualityGrid");
const videoSourceNoteEl = $("videoSourceNote");
const downloadBtn = $("downloadBtn");
const cancelVideoBtn = $("cancelVideoBtn");
const videoProgressEl = $("videoProgress");
const downloadStatusEl = $("downloadStatus");
const smallFileToggle = $("smallFileToggle");

// Audio panel
const audioOptionsEl = $("audioOptions");
const audioSourceNoteEl = $("audioSourceNote");
const downloadAudioBtn = $("downloadAudioBtn");
const cancelAudioBtn = $("cancelAudioBtn");
const audioProgressEl = $("audioProgress");
const audioStatusEl = $("audioStatus");

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
let selectedHeight = null;
let selectedAudio = null;
const downloads = {
  video: { active: false, controller: null, poll: null },
  audio: { active: false, controller: null, poll: null },
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

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

async function getVideo() {
  const url = urlInput.value.trim();

  if (!url) {
    setStatus(statusEl, "Please paste a YouTube URL.", "error");
    return;
  }
  if (!isYouTubeUrl(url)) {
    setStatus(statusEl, "Invalid YouTube URL. Use https://www.youtube.com/watch?v=… or https://youtu.be/…", "error");
    return;
  }

  // The server always works with the canonical URL (status entries, de-dupe).
  // Normalise here too, otherwise progress polling can never match the job
  // (youtu.be links, mobile links, &t=/&list= parameters, ...).
  const normalizedUrl = normalizeYouTubeUrl(url) || url;

  setStatus(statusEl, "Fetching video information…", "loading");
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
    if (!res.ok) throw new Error(data.error || `Failed to retrieve video information. ${apiHint()}`);

    currentUrl = normalizedUrl;
    currentInfo = data;

    vTitleEl.textContent = data.title || "Untitled";
    vChannelEl.textContent = data.channel || "Unknown";
    vDurationEl.textContent =
      data.durationFormatted ||
      (data.duration ? `${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, "0")}` : "Unknown");
    vIdKickerEl.textContent = data.videoId ? `ID ${data.videoId}` : "";
    vUploadDateEl.textContent = data.uploadDateFormatted || data.uploadDate || "Unknown";
    vViewsEl.textContent = data.viewCount != null ? Number(data.viewCount).toLocaleString() : "Unknown";
    vLikesEl.textContent = data.likeCount != null ? Number(data.likeCount).toLocaleString() : "Unknown";
    vQualityCountEl.textContent = (data.formats || []).length
      ? `${(data.formats || []).length} video · ${(data.audioFormats || []).length} audio`
      : "—";
    vDescriptionEl.textContent = data.description || "No description";

    if (data.thumbnail) {
      thumbEl.src = data.thumbnail;
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

    renderVideoOptions(videoFormatsForUi());
    renderAudioOptions(data.audioFormats || [], data.audioSource || null);

    // Reset download UI for the new video
    resetProgress(videoProgressEl);
    resetProgress(audioProgressEl);
    setStatus(downloadStatusEl, "", "");
    setStatus(audioStatusEl, "", "");
    setStatus(intelligenceStatusEl, "", "");
    intelligenceContentEl.classList.add("hidden");
    transcriptTextEl.textContent = "";
    aiOverviewEl.textContent = "";
    aiTopicsEl.innerHTML = "";
    aiKeyPointsEl.innerHTML = "";
    aiProviderEl.textContent = "";
    setStatus(aiErrorEl, "", "");

    resultArea.classList.remove("hidden");
    activateTab("video");
    setStatus(statusEl, "Video ready. Pick a quality and download.", "success");
  } catch (err) {
    setStatus(statusEl, errorMessage(err, "An error occurred."), "error");
    resultArea.classList.add("hidden");
  } finally {
    getVideoBtn.disabled = false;
    const label2 = getVideoBtn.querySelector(".btn-label");
    const spinner2 = getVideoBtn.querySelector(".btn-spinner");
    if (label2) label2.textContent = "Get video";
    if (spinner2) spinner2.classList.add("hidden");
    if (inputShellEl) inputShellEl.style.opacity = "";
  }
}

// ---------------------------------------------------------------------------
// Option grids
// ---------------------------------------------------------------------------

function sourceLabel(plan) {
  if (!plan) return "";
  if (plan.kind === "muxed") return "HLS stream";
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
    empty.textContent = "No downloadable video qualities were found for this video.";
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
    videoSourceNoteEl.textContent = `${plan.label}${codec} · ${sourceLabel(plan)} · includes audio${size}`;
  } else {
    videoSourceNoteEl.textContent = "";
  }
}

function renderAudioOptions(options, audioSource) {
  audioOptionsEl.innerHTML = "";
  if (!options.length) {
    selectedAudio = null;
    downloadAudioBtn.disabled = true;
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
// Downloads
// ---------------------------------------------------------------------------

function downloadWithProgress(url, { statusEl: statusTarget, progressEl }, onProgress) {
  const controller = new AbortController();
  const state = url.includes("/audio") ? downloads.audio : downloads.video;
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
  const wantedId = extractVideoId(url);
  let lastPct = null;
  let lastAt = Date.now();

  state.poll = setInterval(async () => {
    try {
      const res = await fetch(apiUrl("/api/downloads/status"));
      if (!res.ok) return;
      const data = await res.json();
      // Match on the canonical URL, falling back to the video id so the job is
      // found even if the page ever holds a different URL shape.
      const entry = (data.downloads || []).find(
        (d) => d.type === type && (d.url === url || (wantedId && extractVideoId(d.url) === wantedId))
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
    setStatus(intelligenceStatusEl, "Invalid YouTube URL.", "error");
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
tabs.intel.addEventListener("click", () => activateTab("intel"));

downloadBtn.addEventListener("click", downloadVideo);
downloadAudioBtn.addEventListener("click", downloadAudio);
if (smallFileToggle) smallFileToggle.addEventListener("change", refreshVideoOptions);
cancelVideoBtn.addEventListener("click", () => cancelDownload("video"));
cancelAudioBtn.addEventListener("click", () => cancelDownload("audio"));
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
