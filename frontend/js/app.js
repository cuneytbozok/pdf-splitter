/**
 * PDF Splitter – Frontend Application Logic
 *
 * Communicates with the Python backend through:
 *   window.pywebview.api.<method>(args)
 *
 * Receives progress/events via global functions called by
 * Python's window.evaluate_js():
 *   window.__onProgress(data)
 *   window.__onFileComplete(data)
 *   window.__onAllComplete(data)
 *   window.__onError(message)
 */

// ================================================================
// State
// ================================================================
const state = {
  files: [],
  outputFolder: "",
  downloadFolder: "",
  processing: false,
  completedFiles: 0,
  totalFiles: 0,
  gsAvailable: false,
  compressionWorkers: 1,
  compressionEnabled: false,
  partsStarted: [],
  partsCompleted: 0,
  totalParts: 0,
  totalPages: 0,
  partProgress: {},  // partIndex -> 0..1 (tmp_size/input_size) during compression
  completedFileNames: new Set(),  // Basenames of processed files for "open folder" on done items
};

// ================================================================
// DOM References
// ================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  urlInput: $("#urlInput"),
  downloadFolder: $("#downloadFolder"),
  browseDownloadFolderBtn: $("#browseDownloadFolderBtn"),
  addUrlsBtn: $("#addUrlsBtn"),
  dropZone: $("#dropZone"),
  browseBtn: $("#browseBtn"),
  fileQueueSection: $("#fileQueueSection"),
  fileQueue: $("#fileQueue"),
  clearQueueBtn: $("#clearQueueBtn"),
  repairOnly: $("#repairOnly"),
  repairOptionGroup: $("#repairOptionGroup"),
  removeImages: $("#removeImages"),
  removeImagesGroup: $("#removeImagesGroup"),
  splitModeGroup: $("#splitModeGroup"),
  splitValueGroup: $("#splitValueGroup"),
  compressionGroup: $("#compressionGroup"),
  settingsSection: $("#settingsSection"),
  splitMode: $("#splitMode"),
  splitValue: $("#splitValue"),
  splitValueLabel: $("#splitValueLabel"),
  splitValueUnit: $("#splitValueUnit"),
  compression: $("#compression"),
  workersGroup: $("#workersGroup"),
  compressionWorkers: $("#compressionWorkers"),
  workersUnit: $("#workersUnit"),
  ramEstimate: $("#ramEstimate"),
  outputFolder: $("#outputFolder"),
  browseFolderBtn: $("#browseFolderBtn"),
  actionSection: $("#actionSection"),
  startBtn: $("#startBtn"),
  cancelBtn: $("#cancelBtn"),
  progressSection: $("#progressSection"),
  progressFileLabel: $("#progressFileLabel"),
  progressDetail: $("#progressDetail"),
  progressBarFile: $("#progressBarFile"),
  progressPages: $("#progressPages"),
  progressPercent: $("#progressPercent"),
  progressBarOverall: $("#progressBarOverall"),
  overallDetail: $("#overallDetail"),
  overallFiles: $("#overallFiles"),
  overallPercent: $("#overallPercent"),
  workersBlock: $("#workersBlock"),
  workersSlots: $("#workersSlots"),
  completeSection: $("#completeSection"),
  completeTitle: $("#completeTitle"),
  completeSummary: $("#completeSummary"),
  resetBtn: $("#resetBtn"),
  toastContainer: $("#toastContainer"),
};

// ================================================================
// Pywebview API helper
// ================================================================

/**
 * Wait until pywebview.api is available (it injects asynchronously).
 */
function waitForApi() {
  return new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) {
      resolve(window.pywebview.api);
      return;
    }
    // pywebview fires 'pywebviewready' event when the bridge is ready
    window.addEventListener("pywebviewready", () => {
      resolve(window.pywebview.api);
    });
  });
}

let api = null;
waitForApi().then((a) => {
  api = a;
  init();
});

// ================================================================
// Initialization
// ================================================================

async function init() {
  setupDragDrop();
  setupBrowse();
  setupUrlSection();
  setupSettings();
  setupActions();
  setupGlobalCallbacks();

  // Check Ghostscript availability on startup
  try {
    state.gsAvailable = await api.check_gs();
  } catch {
    state.gsAvailable = false;
  }
  if (!state.gsAvailable) {
    showToast(
      "Ghostscript not found. Compression features are disabled. Install via: brew install ghostscript",
      "warning",
      8000
    );
    disableCompression();
  }
  updateUI();
}

// ================================================================
// Drag & Drop
// ================================================================

function setupDragDrop() {
  const zone = dom.dropZone;

  // Visual feedback for drag over
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add("drag-over");
  });

  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("drag-over");
  });

  // The actual file handling is done by pywebview's native drop handler
  // (registered from Python via setup_native_drop). This JS handler only
  // does cleanup and provides a fallback.
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("drag-over");
    // The native handler (Python) will fire window.__onNativeFilesDropped.
    // Nothing else needed here — pywebview intercepts the native paths.
  });

  // Click to open browse
  zone.addEventListener("click", (e) => {
    if (e.target === dom.browseBtn) return;
    openFilePicker();
  });

  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFilePicker();
    }
  });
}

// ================================================================
// File Browsing
// ================================================================

function setupBrowse() {
  dom.browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openFilePicker();
  });

  dom.browseFolderBtn.addEventListener("click", openFolderPicker);
  dom.outputFolder.addEventListener("click", openFolderPicker);
  dom.browseDownloadFolderBtn.addEventListener("click", openDownloadFolderPicker);
  dom.downloadFolder.addEventListener("click", openDownloadFolderPicker);
}

async function openDownloadFolderPicker() {
  if (!api) return;
  try {
    const folder = await api.select_download_folder();
    if (folder) {
      state.downloadFolder = folder;
      dom.downloadFolder.value = folder;
      updateUI();
    }
  } catch (err) {
    const msg = err?.message || String(err) || "Failed to open folder picker.";
    showToast(msg, "error");
  }
}

async function openFilePicker() {
  if (!api) return;
  try {
    const infos = await api.select_files();
    if (infos && infos.length > 0) {
      const added = [];
      for (const info of infos) {
        const isNew = !state.files.some((f) => f.type === "file" && f.path === info.path);
        if (isNew) added.push({ type: "file", path: info.path });
        addFile(info);
      }
      if (added.length > 0 && state.processing) {
        try {
          api.add_items_to_current_run(JSON.stringify(added));
          state.totalFiles = state.files.length;
        } catch (err) {
          showToast("Could not add to current run.", "warning");
        }
      }
      updateUI();
    }
  } catch (err) {
    showToast("Failed to open file picker.", "error");
  }
}

async function openFolderPicker() {
  if (!api) return;
  try {
    const folder = await api.select_output_folder();
    if (folder) {
      state.outputFolder = folder;
      dom.outputFolder.value = folder;
      updateUI();
    }
  } catch (err) {
    const msg = err?.message || String(err) || "Failed to open folder picker.";
    showToast(msg, "error");
  }
}

// ================================================================
// URL Section
// ================================================================

function setupUrlSection() {
  if (dom.addUrlsBtn) {
    dom.addUrlsBtn.addEventListener("click", addUrlsToQueue);
  }
  dom.urlInput.addEventListener("input", updateUI);
  dom.urlInput.addEventListener("paste", () => {
    setTimeout(updateUI, 150);
    setTimeout(updateUI, 300);
  });
  dom.urlInput.addEventListener("change", updateUI);
  dom.urlInput.addEventListener("keyup", updateUI);
  dom.urlInput.addEventListener("focus", () => {
    if ((dom.urlInput?.value?.trim() || "").length > 0) updateUI();
  });
}

function parseUrlsFromText(text) {
  const raw = text
    .split(/[\s\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = raw.filter((s) => /^https?:\/\//i.test(s));
  return [...new Set(urls)];
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function hasUrls() {
  const text = dom.urlInput?.value?.trim() || "";
  return parseUrlsFromText(text).length > 0;
}

// ================================================================
// File Queue Management
// ================================================================

function addFile(info) {
  if (!info.path) return;
  if (state.files.some((f) => f.type === "file" && f.path === info.path)) return;
  state.files.push({ type: "file", ...info });
}

function urlDisplayName(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent((u.pathname || "").split("/").pop() || "document.pdf");
    return name.toLowerCase().endsWith(".pdf") ? name : name + ".pdf";
  } catch {
    return "document.pdf";
  }
}

function addUrlsToQueue() {
  const text = dom.urlInput?.value?.trim() || "";
  const urls = parseUrlsFromText(text);
  if (urls.length === 0) {
    showToast("No valid URLs. Enter http or https URLs, separated by spaces or new lines.", "warning");
    return;
  }
  const existingUrls = new Set(state.files.filter((f) => f.type === "url").map((f) => f.url));
  const added = [];
  for (const url of urls) {
    if (!existingUrls.has(url)) {
      existingUrls.add(url);
      state.files.push({ type: "url", url, name: urlDisplayName(url) });
      added.push({ type: "url", url });
    }
  }
  if (added.length > 0 && state.processing && api) {
    try {
      api.add_items_to_current_run(JSON.stringify(added));
      state.totalFiles = state.files.length;
    } catch (err) {
      showToast("Could not add to current run.", "warning");
    }
  }
  dom.urlInput.value = "";
  updateUI();
}

function removeQueueItem(item) {
  if (item.type === "file") {
    state.files = state.files.filter((f) => !(f.type === "file" && f.path === item.path));
  } else {
    state.files = state.files.filter((f) => !(f.type === "url" && f.url === item.url));
  }
  updateUI();
}

function clearQueue() {
  state.files = [];
  state.completedFileNames.clear();
  updateUI();
}

// ================================================================
// Settings
// ================================================================

const RAM_PER_WORKER_GB = 0.5; // ~500 MB per worker

function setupSettings() {
  dom.repairOnly.addEventListener("change", updateRepairMode);
  dom.splitMode.addEventListener("change", updateSplitModeUI);
  dom.splitValue.addEventListener("input", validateStart);
  dom.clearQueueBtn.addEventListener("click", clearQueue);
  dom.compression.addEventListener("change", updateWorkersVisibility);
  dom.compressionWorkers.addEventListener("input", updateRamEstimate);
  dom.compressionWorkers.addEventListener("change", () => {
    const maxW = parseInt(dom.compressionWorkers.max, 10) || 8;
    const v = Math.min(maxW, Math.max(1, parseInt(dom.compressionWorkers.value) || 2));
    dom.compressionWorkers.value = String(v);
    updateRamEstimate();
  });
  dom.splitValue.addEventListener("input", () => {
    validateStart();
    updateWorkersCap();
  });
  updateRepairMode();
  updateSplitModeUI();
  updateWorkersVisibility();
  updateWorkersCap();
}

function updateRepairMode() {
  const repair = dom.repairOnly.checked;
  dom.splitModeGroup.classList.toggle("hidden", repair);
  dom.splitValueGroup.classList.toggle("hidden", repair);
  dom.compressionGroup.classList.toggle("hidden", repair);
  if (repair) {
    dom.workersGroup.classList.add("hidden");
  } else {
    updateWorkersVisibility();
  }
  validateStart();
}

function updateWorkersVisibility() {
  const hasCompression = dom.compression.value !== "none";
  const repair = dom.repairOnly.checked;
  dom.workersGroup.classList.toggle("hidden", !hasCompression || repair);
  if (hasCompression) updateWorkersCap();
}

function updateRamEstimate() {
  const maxW = parseInt(dom.compressionWorkers.max, 10) || 8;
  const w = Math.min(maxW, Math.max(1, parseInt(dom.compressionWorkers.value) || 2));
  const gb = (w * RAM_PER_WORKER_GB).toFixed(1);
  dom.ramEstimate.textContent = `Estimated peak RAM: ~${gb} GB`;
}

/**
 * Max workers = min(8, max number of parts).
 * Parts mode: number of parts from splitValue.
 * Pages/Size mode: max over selected files of num parts (or 8 when no files).
 */
function computeMaxWorkers() {
  const mode = dom.splitMode.value;
  const splitVal = Math.max(0, parseInt(dom.splitValue.value, 10) || 0);
  const files = state.files.filter((f) => f.type === "file" && f.status !== "error");

  if (mode === "parts") {
    return Math.min(8, Math.max(1, splitVal));
  }
  if (files.length === 0) {
    return 8;
  }
  let maxParts = 1;
  for (const file of files) {
    const pages = file.pages || 1;
    const sizeBytes = file.size_bytes || 0;
    let numParts;
    if (mode === "pages") {
      numParts = Math.ceil(pages / Math.max(1, splitVal));
    } else {
      const targetBytes = splitVal * 1024 * 1024;
      const bytesPerPage = pages > 0 ? sizeBytes / pages : 0;
      const pagesPerPart = Math.max(1, Math.floor(targetBytes / bytesPerPage));
      numParts = Math.ceil(pages / pagesPerPart);
    }
    maxParts = Math.max(maxParts, numParts);
  }
  return Math.min(8, Math.max(1, maxParts));
}

function updateWorkersCap() {
  const maxW = computeMaxWorkers();
  dom.compressionWorkers.max = String(maxW);
  dom.compressionWorkers.min = "1";
  const current = parseInt(dom.compressionWorkers.value, 10) || 1;
  if (current > maxW) {
    dom.compressionWorkers.value = String(maxW);
  }
  dom.workersUnit.textContent = `workers (1–${maxW})`;
  updateRamEstimate();
}

// Default values per split mode
const SPLIT_DEFAULTS = { parts: "4", pages: "500", size: "50" };

function updateSplitModeUI() {
  const mode = dom.splitMode.value;
  switch (mode) {
    case "parts":
      dom.splitValueLabel.textContent = "Number of parts";
      dom.splitValueUnit.textContent = "parts";
      dom.splitValue.min = "2";
      dom.splitValue.value = SPLIT_DEFAULTS.parts;
      dom.splitValue.placeholder = "e.g. 4";
      break;
    case "pages":
      dom.splitValueLabel.textContent = "Max pages per file";
      dom.splitValueUnit.textContent = "pages";
      dom.splitValue.min = "1";
      dom.splitValue.value = SPLIT_DEFAULTS.pages;
      dom.splitValue.placeholder = "e.g. 500";
      break;
    case "size":
      dom.splitValueLabel.textContent = "Target file size";
      dom.splitValueUnit.textContent = "MB";
      dom.splitValue.min = "1";
      dom.splitValue.value = SPLIT_DEFAULTS.size;
      dom.splitValue.placeholder = "e.g. 50";
      break;
  }
  validateStart();
  updateWorkersCap();
}

function disableCompression() {
  dom.compression.value = "none";
  dom.compression.disabled = true;
  dom.compression.title = "Ghostscript is required for compression. Install via: brew install ghostscript";
}

// ================================================================
// Actions (Start / Cancel)
// ================================================================

function setupActions() {
  dom.startBtn.addEventListener("click", startProcessing);
  dom.cancelBtn.addEventListener("click", cancelProcessing);
  dom.resetBtn.addEventListener("click", resetApp);
}

function validateStart() {
  const hasItems = state.files.length > 0;
  const hasOutput = state.outputFolder.length > 0;
  const hasUrlItems = state.files.some((f) => f.type === "url");
  const hasDownloadFolder = !!(state.downloadFolder || state.outputFolder);
  const repair = dom.repairOnly?.checked ?? false;
  const hasValue = repair || parseInt(dom.splitValue?.value) > 0;
  dom.startBtn.disabled = !(
    hasItems &&
    hasOutput &&
    hasValue &&
    (!hasUrlItems || hasDownloadFolder)
  );
  if (dom.addUrlsBtn) {
    const urlsPresent = parseUrlsFromText(dom.urlInput?.value?.trim() || "").length > 0;
    dom.addUrlsBtn.disabled = !(urlsPresent && hasDownloadFolder);
  }
}

async function startProcessing() {
  if (!api || state.processing) return;

  const validFiles = state.files.filter((f) => f.type === "file" && f.status !== "error");
  const validUrlItems = state.files.filter((f) => f.type === "url");
  const hasValidItems = validFiles.length > 0 || validUrlItems.length > 0;

  if (!hasValidItems) {
    showToast("No valid files or URLs to process. Remove errored items and try again.", "error");
    return;
  }
  if (validFiles.length < state.files.filter((f) => f.type === "file").length) {
    showToast(
      `Skipping ${state.files.filter((f) => f.type === "file").length - validFiles.length} file(s) with errors.`,
      "warning"
    );
  }

  const repairOnly = dom.repairOnly.checked;

  if (!repairOnly && validFiles.length > 0 && dom.splitMode.value === "parts") {
    const splitValue = parseInt(dom.splitValue.value) || 4;
    const minPages = Math.min(...validFiles.map((f) => f.pages));
    if (splitValue > minPages) {
      showToast(
        `Cannot split into ${splitValue} parts — one of your files has only ${minPages} pages.`,
        "error"
      );
      return;
    }
  }

  const items = state.files
    .filter((f) => (f.type === "file" && f.status !== "error") || f.type === "url")
    .map((f) => (f.type === "url" ? { type: "url", url: f.url } : { type: "file", path: f.path }));

  let downloadFolder = state.downloadFolder || state.outputFolder;
  if (validUrlItems.length > 0 && !downloadFolder) {
    showToast("Select a download folder for URL items.", "warning");
    return;
  }

  const config = {
    items,
    downloadFolder: downloadFolder || "",
    outputFolder: state.outputFolder,
    splitMode: repairOnly ? "parts" : dom.splitMode.value,
    splitValue: repairOnly ? 1 : parseInt(dom.splitValue.value),
    compression: repairOnly ? "none" : dom.compression.value,
    repairOnly,
    workers: repairOnly ? 1 : Math.min(
      parseInt(dom.compressionWorkers.max, 10) || 8,
      Math.max(1, parseInt(dom.compressionWorkers.value) || 2)
    ),
    removeImages: dom.removeImages?.checked ?? false,
  };

  state.processing = true;
  state.repairOnly = repairOnly;
  state.compressionWorkers = config.workers;
  state.compressionEnabled = config.compression !== "none";
  state.partsStarted = [];
  state.partsCompleted = 0;
  state.completedFiles = 0;
  state.totalFiles = items.length;

  dom.startBtn.classList.add("hidden");
  dom.cancelBtn.classList.remove("hidden");
  dom.progressSection.classList.remove("hidden");
  dom.completeSection.classList.add("hidden");

  setSettingsEnabled(false);

  updateProgressUI(0, 1, 0, 1, "Starting...", 0);
  updateOverallUI(0, state.totalFiles);

  try {
    await api.start_unified_processing(JSON.stringify(config));
  } catch (err) {
    showToast(`Failed to start processing: ${err}`, "error");
    resetProcessingUI();
  }
}

async function cancelProcessing() {
  if (!api) return;
  try {
    await api.cancel_processing();
    await api.cancel_downloads();
    showToast("Cancelling... please wait.", "warning");
  } catch (err) {
    showToast("Failed to cancel.", "error");
  }
}

// ================================================================
// Progress Callbacks (called from Python via evaluate_js)
// ================================================================

function setupGlobalCallbacks() {
  window.__onProgress = (data) => {
    if (data.status && data.status.startsWith("Starting")) {
      state.partsStarted = [];
      state.partsCompleted = 0;
      state.partProgress = {};
    }
    state.totalParts = data.totalParts || 0;
    state.totalPages = data.totalPages || 0;
    const isPartsDone = data.status && data.status.includes("parts done");
    if (isPartsDone) {
      state.partsCompleted = data.currentPart || 0;
    }
    const fileProgress = computeFileProgress(
      data.currentPage,
      data.totalPages,
      data.currentPart,
      data.totalParts,
      data.status
    );
    updateProgressUI(
      data.currentPage,
      data.totalPages,
      data.currentPart,
      data.totalParts,
      data.status,
      fileProgress
    );
    updateWorkersUI();
    updateOverallUI(state.completedFiles, state.totalFiles, fileProgress);
  };

  window.__onFileComplete = (data) => {
    state.completedFiles++;
    state.completedFileNames.add(data.filename);
    state.partsStarted = [];
    state.partsCompleted = 0;
    state.partProgress = {};
    updateWorkersUI();
    updateOverallUI(state.completedFiles, state.totalFiles, 0);
    renderFileQueue();
  };

  window.__onCompressProgress = (data) => {
    const estimatedOutput = Math.max(1, data.estimatedOutput || data.inputSize || 1);
    state.partProgress[data.partIndex] = Math.min(1, (data.tmpSize || 0) / estimatedOutput);
    const fileProgress = computeFileProgressFromState();
    updateProgressUI(
      state.totalPages,
      state.totalPages,
      state.partsCompleted,
      state.totalParts,
      "Compressing...",
      fileProgress
    );
    updateOverallUI(state.completedFiles, state.totalFiles, fileProgress);
  };

  window.__onCompressPartStart = (partIndex) => {
    state.partsStarted.push(partIndex);
    updateWorkersUI();
    // In parallel mode we don't get __onProgress until a part completes, so refresh
    // the progress UI now: we're in compression phase (split done, workers active).
    if (state.totalPages > 0 && state.totalParts > 0) {
      const fileProgress = state.compressionEnabled
        ? 0.5 + 0.5 * (state.partsCompleted / state.totalParts)
        : 1;
      updateProgressUI(
        state.totalPages,
        state.totalPages,
        state.partsCompleted,
        state.totalParts,
        "Compressing...",
        fileProgress
      );
      updateOverallUI(state.completedFiles, state.totalFiles, fileProgress);
    }
  };

  window.__onAllComplete = (summary) => {
    state.processing = false;

    if (summary.cancelled) {
      dom.completeTitle.textContent = "Processing Cancelled";
      dom.completeSummary.textContent =
        `Completed ${summary.completedFiles} of ${summary.totalFiles} files ` +
        `(${summary.totalParts} parts) in ${summary.elapsedSeconds}s before cancellation.`;
    } else {
      dom.completeTitle.textContent = "Processing Complete";
      dom.completeSummary.textContent = state.repairOnly
        ? `Repaired ${summary.completedFiles} file${summary.completedFiles !== 1 ? "s" : ""} in ${summary.elapsedSeconds}s.`
        : `Successfully split ${summary.completedFiles} file${summary.completedFiles !== 1 ? "s" : ""} ` +
          `into ${summary.totalParts} parts in ${summary.elapsedSeconds}s.`;
    }

    dom.progressSection.classList.add("hidden");
    dom.completeSection.classList.remove("hidden");
    dom.cancelBtn.classList.add("hidden");
    dom.startBtn.classList.remove("hidden");
    dom.startBtn.disabled = true;
    setSettingsEnabled(true);
    validateStart();
  };

  window.__onPhaseProgress = (data) => {
    if (!data) return;
    if (data.phase === "download") {
      dom.progressFileLabel.textContent = `Downloading ${data.currentFile} of ${data.totalFiles}: ${data.filename || "..."}`;
      const pct = data.percent >= 0 ? data.percent : 0;
      dom.progressBarFile.style.width = pct + "%";
      dom.progressPercent.textContent = pct + "%";
      if (data.totalBytes >= 0) {
        dom.progressDetail.textContent = `${formatBytes(data.bytesReceived)} / ${formatBytes(data.totalBytes)}`;
      } else {
        dom.progressDetail.textContent = formatBytes(data.bytesReceived || 0);
      }
      dom.progressPages.textContent = "";
    } else if (data.phase === "process") {
      dom.progressFileLabel.textContent = `Processing ${data.currentFile} of ${data.totalFiles}: ${data.filename || "..."}`;
    }
  };

  window.__onError = (message) => {
    showToast(message, "error");
  };

  // Native drag-and-drop handler (called from Python via evaluate_js)
  window.__onNativeFilesDropped = (infos) => {
    if (!infos || infos.length === 0) return;
    const added = [];
    for (const info of infos) {
      const isNew = !state.files.some((f) => f.type === "file" && f.path === info.path);
      if (isNew) added.push({ type: "file", path: info.path });
      addFile(info);
    }
    if (added.length > 0 && state.processing && api) {
      try {
        api.add_items_to_current_run(JSON.stringify(added));
        state.totalFiles = state.files.length;
      } catch (err) {
        showToast("Could not add to current run.", "warning");
      }
    }
    updateUI();
  };

}

// ================================================================
// UI Update Helpers
// ================================================================

function updateUI() {
  renderFileQueue();
  updateVisibilityFromState();
  validateStart();
  updateWorkersCap();
}

function updateVisibilityFromState() {
  const hasFiles = state.files.length > 0;
  const urlsPresent = hasUrls();
  const showSettings = hasFiles || urlsPresent || state.processing;
  const showActionSection = hasFiles || urlsPresent || state.processing;

  const wasSettingsHidden = dom.settingsSection.classList.contains("hidden");
  dom.fileQueueSection.classList.toggle("hidden", !hasFiles);
  dom.settingsSection.classList.toggle("hidden", !showSettings);
  dom.actionSection.classList.toggle("hidden", !showActionSection);

  if (wasSettingsHidden && showSettings && dom.settingsSection) {
    dom.settingsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderFileQueue() {
  dom.fileQueue.innerHTML = "";
  for (const item of state.files) {
    const isDone = state.completedFileNames.has(item.name);
    const statusText = isDone ? "Done" : (item.type === "url" ? "URL" : statusLabel(item.status));
    const statusClass = isDone ? "ok" : (item.type === "url" ? "pending" : item.status);
    const folderBtn = isDone && state.outputFolder
      ? `<button class="file-item-open-folder" title="Open output folder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <polyline points="2 12 5 12 7 8 22 8"/>
          </svg>
        </button>`
      : "";
    const li = document.createElement("li");
    li.className = "file-item";
    if (item.type === "url") {
      li.innerHTML = `
        <div class="file-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </div>
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(item.url)}">${escapeHtml(item.name)}</div>
          <div class="file-item-meta">${isDone ? "Processed" : "Pending download"}</div>
        </div>
        <span class="file-item-status ${statusClass}">${statusText}</span>
        ${folderBtn}
        <button class="file-item-remove" title="Remove" data-url="${escapeHtml(item.url)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
    } else {
      li.innerHTML = `
        <div class="file-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
          <div class="file-item-meta">${item.pages.toLocaleString()} pages &middot; ${item.size_human}</div>
        </div>
        <span class="file-item-status ${statusClass}">${statusText}</span>
        ${folderBtn}
        <button class="file-item-remove" title="Remove" data-path="${escapeHtml(item.path)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
    }
    li.querySelector(".file-item-remove").addEventListener("click", () => removeQueueItem(item));
    const folderEl = li.querySelector(".file-item-open-folder");
    if (folderEl && api && state.outputFolder) {
      folderEl.addEventListener("click", () => {
        try {
          api.open_folder(state.outputFolder);
        } catch (err) {
          showToast("Could not open folder.", "error");
        }
      });
    }
    dom.fileQueue.appendChild(li);
  }
}

/**
 * Compute compression-phase progress from state.partProgress.
 * Uses tmp file size / input size per part; completed parts = 1.
 */
function computeFileProgressFromState() {
  if (!state.compressionEnabled || state.totalParts <= 0) return 0.5;
  const completed = state.partsStarted.slice(0, state.partsCompleted);
  let sum = 0;
  for (let i = 1; i <= state.totalParts; i++) {
    if (completed.includes(i)) {
      sum += 1;
    } else {
      sum += state.partProgress[i] ?? 0;
    }
  }
  const compressFraction = sum / state.totalParts;
  return 0.5 + 0.5 * compressFraction;
}

/**
 * Compute current file progress 0..1.
 * During split: page-based — currentPage/totalPages (e.g. 500/1000 = 50%).
 * During compress: uses partProgress (tmp/input per part) when available.
 */
function computeFileProgress(currentPage, totalPages, currentPart, totalParts, status) {
  if (totalPages <= 0 || (currentPart === 0 && !status)) return 0;
  if (status && status.startsWith("Starting")) return 0;

  const isPartsDone = status && status.includes("parts done");
  const isCompressing = status && status.toLowerCase().includes("compressing");
  const workersActive = state.partsStarted.length > 0;
  const hasCompression = state.compressionEnabled;

  if (isPartsDone) {
    state.partsCompleted = currentPart;
    const completed = state.partsStarted.slice(0, currentPart);
    completed.forEach((i) => { state.partProgress[i] = 1; });
    const compressFraction = currentPart / totalParts;
    return hasCompression ? 0.5 + 0.5 * compressFraction : 1;
  }
  if (isCompressing || workersActive) {
    if (Object.keys(state.partProgress).length > 0) {
      return computeFileProgressFromState();
    }
    const partsDone = isCompressing ? currentPart - 1 : 0;
    const compressFraction = totalParts > 0 ? partsDone / totalParts : 0;
    return hasCompression ? 0.5 + 0.5 * compressFraction : 1;
  }
  const splitFraction = totalPages > 0 ? Math.min(1, currentPage / totalPages) : 0;
  return hasCompression ? 0.5 * splitFraction : splitFraction;
}

function updateProgressUI(currentPage, totalPages, currentPart, totalParts, status, fileProgress) {
  const isStarting = status && status.startsWith("Starting");
  const isCompressing = status && status.toLowerCase().includes("compressing");
  const isPartsDone = status && status.includes("parts done");
  const workersActive = state.partsStarted.length > 0 && state.compressionWorkers > 1;
  const pct = Math.round(Math.min(100, fileProgress * 100));

  // Main label: phase + percent (workersActive = parallel compress started, no status yet)
  const phaseLabel = isCompressing || isPartsDone || workersActive ? "Compressing" : "Splitting";
  dom.progressFileLabel.textContent = isStarting ? status : `${phaseLabel} — ${pct}%`;

  // Detail: part info only (no MB — intermediate sizes are misleading)
  if (isStarting) {
    dom.progressDetail.textContent = "";
    dom.progressPages.textContent = "0 pages";
  } else if (isPartsDone) {
    dom.progressDetail.textContent = `${currentPart} of ${totalParts} parts compressed`;
    dom.progressPages.textContent = `${totalPages.toLocaleString()} pages`;
  } else if (isCompressing || workersActive) {
    const doneText = state.partsCompleted > 0
      ? `${state.partsCompleted} of ${totalParts} parts done`
      : `${state.partsStarted.length} of ${totalParts} compressing`;
    dom.progressDetail.textContent = doneText;
    dom.progressPages.textContent = `${totalPages.toLocaleString()} pages (split done)`;
  } else {
    dom.progressDetail.textContent = status || `Part ${currentPart} of ${totalParts} — writing pages`;
    dom.progressPages.textContent = `${currentPage.toLocaleString()} / ${totalPages.toLocaleString()} pages`;
  }

  dom.progressBarFile.style.width = pct + "%";
  dom.progressPercent.textContent = pct + "%";
  dom.progressBarFile.classList.toggle("compressing", isCompressing || isPartsDone || workersActive);
}

function updateWorkersUI() {
  const show = state.compressionWorkers > 1 && state.totalParts >= 2 &&
    (state.partsStarted.length > 0 || state.partsCompleted > 0);
  dom.workersBlock.classList.toggle("hidden", !show);
  if (!show) return;

  const inProgress = state.partsStarted.slice(state.partsCompleted);
  const completed = state.partsStarted.slice(0, state.partsCompleted);

  dom.workersSlots.innerHTML = "";
  for (let i = 1; i <= state.totalParts; i++) {
    const span = document.createElement("span");
    span.className = "worker-slot";
    if (completed.includes(i)) {
      span.classList.add("done");
      span.textContent = `Part ${i} — done`;
    } else if (inProgress.includes(i)) {
      span.classList.add("compressing");
      span.textContent = `Part ${i} — compressing`;
    } else {
      span.classList.add("waiting");
      span.textContent = `Part ${i} — waiting`;
    }
    dom.workersSlots.appendChild(span);
  }
}

function updateOverallUI(completed, total, fileProgress = 0) {
  const overallFraction = total > 0 ? (completed + fileProgress) / total : 0;
  const pct = Math.round(Math.min(100, overallFraction * 100));
  dom.progressBarOverall.style.width = pct + "%";
  dom.overallFiles.textContent = `${completed} / ${total} files`;
  dom.overallPercent.textContent = pct + "%";
  dom.overallDetail.textContent =
    completed < total
      ? `${completed} of ${total} files complete (current file ${Math.round(fileProgress * 100)}%)`
      : `${completed} of ${total} files complete`;
}

function setSettingsEnabled(enabled) {
  dom.repairOnly.disabled = !enabled;
  dom.removeImages.disabled = !enabled;
  dom.splitMode.disabled = !enabled;
  dom.splitValue.disabled = !enabled;
  // Keep compression disabled if GS is not available
  dom.compression.disabled = !enabled || !state.gsAvailable;
  dom.compressionWorkers.disabled = !enabled;
  dom.browseFolderBtn.disabled = !enabled;
  // Keep URL input, drop zone, and add-to-queue enabled during processing so user can queue more for next run
  dom.dropZone.style.pointerEvents = "auto";
  dom.dropZone.style.opacity = "1";
  dom.urlInput.disabled = false;
  if (dom.addUrlsBtn) dom.addUrlsBtn.disabled = !(parseUrlsFromText(dom.urlInput?.value?.trim() || "").length > 0 && (state.downloadFolder || state.outputFolder));
  dom.browseDownloadFolderBtn.disabled = false;
  dom.downloadFolder.style.pointerEvents = "auto";
}

function resetProcessingUI() {
  state.processing = false;
  dom.cancelBtn.classList.add("hidden");
  dom.startBtn.classList.remove("hidden");
  dom.progressSection.classList.add("hidden");
  setSettingsEnabled(true);
  validateStart();
}

function resetApp() {
  state.files = [];
  state.outputFolder = "";
  state.completedFileNames.clear();
  state.processing = false;
  state.completedFiles = 0;
  state.totalFiles = 0;
  state.partsStarted = [];
  state.partsCompleted = 0;
  state.partProgress = {};

  dom.outputFolder.value = "";
  dom.completeSection.classList.add("hidden");
  dom.progressSection.classList.add("hidden");
  dom.cancelBtn.classList.add("hidden");
  dom.startBtn.classList.remove("hidden");

  updateUI();
}

// ================================================================
// Toast Notifications
// ================================================================

function showToast(message, type = "error", durationMs = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  dom.toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add("fade-out");
    el.addEventListener("animationend", () => el.remove());
  }, durationMs);
}

// ================================================================
// Utilities
// ================================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function statusLabel(status) {
  switch (status) {
    case "ok":
      return "Ready";
    case "needs_repair":
      return "Needs repair";
    case "error":
      return "Error";
    case "pending":
      return "URL";
    default:
      return status;
  }
}
