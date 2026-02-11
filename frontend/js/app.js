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
  files: [],          // Array of { path, name, pages, size_bytes, size_human, status, error }
  outputFolder: "",
  processing: false,
  completedFiles: 0,
  totalFiles: 0,
  gsAvailable: false,
};

// ================================================================
// DOM References
// ================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  dropZone: $("#dropZone"),
  browseBtn: $("#browseBtn"),
  fileQueueSection: $("#fileQueueSection"),
  fileQueue: $("#fileQueue"),
  clearQueueBtn: $("#clearQueueBtn"),
  settingsSection: $("#settingsSection"),
  splitMode: $("#splitMode"),
  splitValue: $("#splitValue"),
  splitValueLabel: $("#splitValueLabel"),
  splitValueUnit: $("#splitValueUnit"),
  compression: $("#compression"),
  workersGroup: $("#workersGroup"),
  compressionWorkers: $("#compressionWorkers"),
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
}

async function openFilePicker() {
  if (!api) return;
  try {
    const infos = await api.select_files();
    if (infos && infos.length > 0) {
      for (const info of infos) {
        addFile(info);
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
      validateStart();
    }
  } catch (err) {
    showToast("Failed to open folder picker.", "error");
  }
}

// ================================================================
// File Queue Management
// ================================================================

function addFile(info) {
  // Deduplicate by path
  if (state.files.some((f) => f.path === info.path)) return;
  state.files.push(info);
}

function removeFile(path) {
  state.files = state.files.filter((f) => f.path !== path);
  updateUI();
}

function clearQueue() {
  state.files = [];
  updateUI();
}

// ================================================================
// Settings
// ================================================================

const RAM_PER_WORKER_GB = 0.5; // ~500 MB per worker

function setupSettings() {
  dom.splitMode.addEventListener("change", updateSplitModeUI);
  dom.splitValue.addEventListener("input", validateStart);
  dom.clearQueueBtn.addEventListener("click", clearQueue);
  dom.compression.addEventListener("change", updateWorkersVisibility);
  dom.compressionWorkers.addEventListener("input", updateRamEstimate);
  dom.compressionWorkers.addEventListener("change", () => {
    const v = Math.min(8, Math.max(1, parseInt(dom.compressionWorkers.value) || 2));
    dom.compressionWorkers.value = String(v);
    updateRamEstimate();
  });
  updateSplitModeUI();
  updateWorkersVisibility();
  updateRamEstimate();
}

function updateWorkersVisibility() {
  const hasCompression = dom.compression.value !== "none";
  dom.workersGroup.classList.toggle("hidden", !hasCompression);
}

function updateRamEstimate() {
  const w = Math.min(8, Math.max(1, parseInt(dom.compressionWorkers.value) || 2));
  const gb = (w * RAM_PER_WORKER_GB).toFixed(1);
  dom.ramEstimate.textContent = `Estimated peak RAM: ~${gb} GB`;
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
  const hasFiles = state.files.length > 0;
  const hasOutput = state.outputFolder.length > 0;
  const hasValue = parseInt(dom.splitValue.value) > 0;
  dom.startBtn.disabled = !(hasFiles && hasOutput && hasValue);
}

async function startProcessing() {
  if (!api || state.processing) return;

  // Filter out files that had errors during analysis
  const validFiles = state.files.filter((f) => f.status !== "error");
  if (validFiles.length === 0) {
    showToast("No valid PDF files to process. Remove errored files and try again.", "error");
    return;
  }
  if (validFiles.length < state.files.length) {
    showToast(
      `Skipping ${state.files.length - validFiles.length} file(s) with errors.`,
      "warning"
    );
  }

  // Validate split value makes sense
  const splitValue = parseInt(dom.splitValue.value);
  if (dom.splitMode.value === "parts") {
    const minPages = Math.min(...validFiles.map((f) => f.pages));
    if (splitValue > minPages) {
      showToast(
        `Cannot split into ${splitValue} parts — one of your files has only ${minPages} pages.`,
        "error"
      );
      return;
    }
  }

  const workers = Math.min(8, Math.max(1, parseInt(dom.compressionWorkers.value) || 2));

  const config = {
    files: validFiles.map((f) => f.path),
    splitMode: dom.splitMode.value,
    splitValue: splitValue,
    compression: dom.compression.value,
    workers: workers,
    outputFolder: state.outputFolder,
  };

  state.processing = true;
  state.completedFiles = 0;
  state.totalFiles = state.files.length;

  // Show progress, hide others
  dom.startBtn.classList.add("hidden");
  dom.cancelBtn.classList.remove("hidden");
  dom.progressSection.classList.remove("hidden");
  dom.completeSection.classList.add("hidden");

  // Disable settings
  setSettingsEnabled(false);

  // Reset progress UI
  updateProgressUI(0, 1, 0, 1, "Starting...");
  updateOverallUI(0, state.totalFiles);

  try {
    await api.start_processing(JSON.stringify(config));
  } catch (err) {
    showToast(`Failed to start processing: ${err}`, "error");
    resetProcessingUI();
  }
}

async function cancelProcessing() {
  if (!api) return;
  try {
    await api.cancel_processing();
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
    updateProgressUI(
      data.currentPage,
      data.totalPages,
      data.currentPart,
      data.totalParts,
      data.status
    );
  };

  window.__onFileComplete = (data) => {
    state.completedFiles++;
    updateOverallUI(state.completedFiles, state.totalFiles);
    markFileComplete(data.filename);
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
      dom.completeSummary.textContent =
        `Successfully split ${summary.completedFiles} file${summary.completedFiles !== 1 ? "s" : ""} ` +
        `into ${summary.totalParts} parts in ${summary.elapsedSeconds}s.`;
    }

    dom.progressSection.classList.add("hidden");
    dom.completeSection.classList.remove("hidden");
    dom.cancelBtn.classList.add("hidden");
    dom.startBtn.classList.remove("hidden");
    dom.startBtn.disabled = true;
    setSettingsEnabled(true);
  };

  window.__onError = (message) => {
    showToast(message, "error");
  };

  // Native drag-and-drop handler (called from Python via evaluate_js)
  window.__onNativeFilesDropped = (infos) => {
    if (!infos || infos.length === 0) return;
    for (const info of infos) {
      addFile(info);
    }
    updateUI();
  };
}

// ================================================================
// UI Update Helpers
// ================================================================

function updateUI() {
  renderFileQueue();

  const hasFiles = state.files.length > 0;
  dom.fileQueueSection.classList.toggle("hidden", !hasFiles);
  dom.settingsSection.classList.toggle("hidden", !hasFiles);
  dom.actionSection.classList.toggle("hidden", !hasFiles);

  validateStart();
}

function renderFileQueue() {
  dom.fileQueue.innerHTML = "";
  for (const file of state.files) {
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `
      <div class="file-item-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <div class="file-item-info">
        <div class="file-item-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</div>
        <div class="file-item-meta">${file.pages.toLocaleString()} pages &middot; ${file.size_human}</div>
      </div>
      <span class="file-item-status ${file.status}">${statusLabel(file.status)}</span>
      <button class="file-item-remove" title="Remove" data-path="${escapeHtml(file.path)}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    li.querySelector(".file-item-remove").addEventListener("click", () => {
      removeFile(file.path);
    });
    dom.fileQueue.appendChild(li);
  }
}

function markFileComplete(filename) {
  const items = dom.fileQueue.querySelectorAll(".file-item");
  for (const item of items) {
    const nameEl = item.querySelector(".file-item-name");
    if (nameEl && nameEl.textContent === filename) {
      const statusEl = item.querySelector(".file-item-status");
      if (statusEl) {
        statusEl.className = "file-item-status ok";
        statusEl.textContent = "Done";
      }
    }
  }
}

function updateProgressUI(currentPage, totalPages, currentPart, totalParts, status) {
  const isCompressing = status && status.toLowerCase().includes("compressing");
  const isPartsDone = status && status.includes("parts done"); // parallel compression
  const totalSteps = totalParts * 2; // each part: split + compress

  let pct;
  if (isPartsDone) {
    // Parallel compression: currentPart = parts compressed so far, bar 50% → 100%
    pct = totalParts > 0 ? Math.round(50 + (50 * currentPart) / totalParts) : 50;
    dom.progressPages.textContent = `${totalPages.toLocaleString()} pages written`;
    dom.progressDetail.textContent = status || `Compressing (${currentPart} of ${totalParts} parts done)`;
  } else if (isCompressing) {
    // Sequential: compressing part K = step 2K done, no sub-progress
    pct = totalSteps > 0 ? Math.round(((2 * currentPart - 1) / totalSteps) * 100) : 0;
    dom.progressPages.textContent = `${currentPage.toLocaleString()} / ${totalPages.toLocaleString()} pages written`;
    const hasSizeUpdate = status && status.includes("output so far");
    dom.progressDetail.textContent = hasSizeUpdate
      ? `Compressing part ${currentPart} of ${totalParts} — output file growing`
      : `Compressing part ${currentPart} of ${totalParts} — may take several minutes`;
  } else {
    // Splitting: progress = (step - 1 + progress_in_step) / totalSteps
    const stepIndex = (currentPart - 1) * 2 + 1;
    const pagesPerPart = totalPages / totalParts;
    const progressInStep = pagesPerPart > 0
      ? Math.min(1, (currentPage - (currentPart - 1) * pagesPerPart) / pagesPerPart)
      : 0;
    pct = totalSteps > 0 ? Math.round(((stepIndex - 1 + progressInStep) / totalSteps) * 100) : 0;
    dom.progressPages.textContent = `${currentPage.toLocaleString()} / ${totalPages.toLocaleString()} pages`;
    dom.progressDetail.textContent = `Part ${currentPart} of ${totalParts}`;
  }

  dom.progressBarFile.style.width = Math.min(100, pct) + "%";
  dom.progressPercent.textContent = pct + "%";
  dom.progressFileLabel.textContent = status || "Processing...";

  dom.progressBarFile.classList.toggle("compressing", isCompressing || isPartsDone);
}

function updateOverallUI(completed, total) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  dom.progressBarOverall.style.width = pct + "%";
  dom.overallFiles.textContent = `${completed} / ${total} files`;
  dom.overallPercent.textContent = pct + "%";
  dom.overallDetail.textContent = `${completed} of ${total} files complete`;
}

function setSettingsEnabled(enabled) {
  dom.splitMode.disabled = !enabled;
  dom.splitValue.disabled = !enabled;
  // Keep compression disabled if GS is not available
  dom.compression.disabled = !enabled || !state.gsAvailable;
  dom.compressionWorkers.disabled = !enabled;
  dom.browseFolderBtn.disabled = !enabled;
  dom.dropZone.style.pointerEvents = enabled ? "auto" : "none";
  dom.dropZone.style.opacity = enabled ? "1" : "0.5";
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
  state.processing = false;
  state.completedFiles = 0;
  state.totalFiles = 0;

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
    default:
      return status;
  }
}
