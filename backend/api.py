"""
PyWebView JS API – the bridge between frontend JavaScript and Python backend.

Every public method on the Api class is callable from JS via:
    window.pywebview.api.method_name(args)
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections import deque
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import webview

from backend.analyzer import analyze
from backend.compressor import gs_available, COMPRESSION_PRESETS
from backend.downloader import download_pdf
from backend.splitter import split_by_parts, split_by_max_pages, split_by_target_size


class Api:
    """Exposed to JavaScript through pywebview's js_api mechanism."""

    # Minimum interval between progress pushes (seconds).
    # Prevents flooding the WebView with evaluate_js calls on large PDFs.
    PROGRESS_THROTTLE = 0.08  # ~12 updates/sec

    def __init__(self) -> None:
        self._window: Optional[webview.Window] = None
        self._cancel_flag = threading.Event()
        self._cancel_downloads_flag = threading.Event()
        self._processing = False
        self._downloading = False
        self._last_progress_push: float = 0.0
        self._pending_items_queue: queue.Queue[dict] = queue.Queue()

    # ------------------------------------------------------------------
    # Window reference (set by main.py after window creation)
    # ------------------------------------------------------------------
    def set_window(self, window: webview.Window) -> None:
        self._window = window

    # ------------------------------------------------------------------
    # Native drag-and-drop (registered after page load)
    # ------------------------------------------------------------------
    def setup_native_drop(self, window: webview.Window) -> None:
        """
        Register a native drop handler on the drop zone element.

        pywebview's native layer (Cocoa/GTK/Edge) intercepts drag operations
        and stores real file system paths. These are only available when a
        Python-side 'drop' event listener is registered through the DOM API.
        Plain JavaScript cannot access File.path in WebKit.
        """
        try:
            drop_zone = window.dom.get_element("#dropZone")
            if drop_zone is None:
                return

            from webview.dom import DOMEventHandler

            def on_native_drop(event: dict) -> None:
                files = event.get("dataTransfer", {}).get("files", [])
                pdf_paths = []
                for f in files:
                    full_path = f.get("pywebviewFullPath", "")
                    name = f.get("name", "")
                    if full_path and name.lower().endswith(".pdf"):
                        pdf_paths.append(full_path)

                if not pdf_paths:
                    self._push_js(
                        "window.__onError('No PDF files found in drop. Use Browse instead.')"
                    )
                    return

                # Analyze each dropped PDF and push results to JS
                infos = []
                for path in pdf_paths:
                    try:
                        info = dict(analyze(path))
                        infos.append(info)
                    except Exception as exc:
                        self._push_js(
                            f"window.__onError({json.dumps(f'Failed to analyze {path}: {exc}')})"
                        )

                if infos:
                    self._push_js(
                        f"window.__onNativeFilesDropped({json.dumps(infos)})"
                    )

            handler = DOMEventHandler(on_native_drop, prevent_default=True)
            drop_zone.on("drop", handler)
        except Exception as e:
            print(f"[warning] Native drop setup failed: {e}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _push_js(self, fn_call: str) -> None:
        """Evaluate a JavaScript expression in the frontend."""
        if self._window:
            try:
                self._window.evaluate_js(fn_call)
            except Exception:
                pass  # window may have closed

    def _push_progress(
        self,
        current_page: int,
        total_pages: int,
        current_part: int,
        total_parts: int,
        status: str,
        *,
        bytes_written: Optional[int] = None,
    ) -> None:
        now = time.time()
        is_final = (current_page >= total_pages)
        is_part_boundary = (current_page == total_pages) or ("Compressing" in status)

        # Throttle intermediate updates; always push final / part-boundary
        if not is_final and not is_part_boundary:
            if (now - self._last_progress_push) < self.PROGRESS_THROTTLE:
                return

        self._last_progress_push = now
        payload: dict[str, Any] = {
            "currentPage": current_page,
            "totalPages": total_pages,
            "currentPart": current_part,
            "totalParts": total_parts,
            "status": status,
        }
        if bytes_written is not None:
            payload["bytesWritten"] = bytes_written
        data = json.dumps(payload)
        self._push_js(f"window.__onProgress({data})")

    def _push_file_complete(self, filename: str, parts: list[str]) -> None:
        data = json.dumps({"filename": filename, "parts": parts})
        self._push_js(f"window.__onFileComplete({data})")

    def _push_all_complete(self, summary: dict) -> None:
        self._push_js(f"window.__onAllComplete({json.dumps(summary)})")

    def _push_error(self, message: str) -> None:
        self._push_js(f"window.__onError({json.dumps(message)})")

    def _push_compress_part_start(self, part_index: int) -> None:
        """Notify frontend that a worker started compressing part_index (1-based)."""
        self._push_js(f"window.__onCompressPartStart({part_index})")

    def _push_compress_progress(
        self,
        part_index: int,
        tmp_size: int,
        input_size: int,
        estimated_output: int,
    ) -> None:
        """Notify frontend of compression progress (tmp file growing)."""
        payload = json.dumps({
            "partIndex": part_index,
            "tmpSize": tmp_size,
            "inputSize": input_size,
            "estimatedOutput": estimated_output,
        })
        self._push_js(f"window.__onCompressProgress({payload})")

    # ------------------------------------------------------------------
    # Public API: called from JavaScript
    # ------------------------------------------------------------------

    def select_files(self) -> list[dict[str, Any]]:
        """Open native file dialog. Returns list of analyzed PDF info dicts."""
        if not self._window:
            return []
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            allow_multiple=True,
            file_types=("PDF Files (*.pdf)",),
        )
        if not result:
            return []
        infos = []
        for path in result:
            infos.append(analyze(path))
        return infos

    def select_output_folder(self) -> str:
        """Open native folder dialog. Returns selected path or empty string."""
        if not self._window:
            return ""
        try:
            result = self._window.create_file_dialog(webview.FileDialog.FOLDER)
            if result and len(result) > 0:
                return result[0]
            return ""
        except Exception as exc:
            msg = str(exc) if exc else "Unknown error"
            raise RuntimeError(f"Folder picker failed: {msg}") from exc

    def analyze_pdf(self, file_path: str) -> dict[str, Any]:
        """Analyze a single PDF and return its info."""
        return dict(analyze(file_path))

    def check_gs(self) -> bool:
        """Check if Ghostscript is available."""
        return gs_available()

    def open_folder(self, path: str) -> None:
        """Open the given folder in the system file manager."""
        if not path or not os.path.isdir(path):
            return
        try:
            if sys.platform == "darwin":
                subprocess.run(["open", path], check=False)
            elif sys.platform == "win32":
                subprocess.run(["explorer", path], check=False)
            else:
                subprocess.run(["xdg-open", path], check=False)
        except Exception:
            pass

    def get_compression_presets(self) -> list[dict[str, str]]:
        """Return available compression presets for the UI dropdown."""
        labels = {
            "low": "High compression (smallest files)",
            "medium": "Medium compression (balanced)",
            "high": "Low compression (high quality)",
            "maximum": "Minimal compression (largest files)",
        }
        return [
            {"value": key, "label": labels.get(key, key)}
            for key in COMPRESSION_PRESETS
        ]

    def is_processing(self) -> bool:
        return self._processing

    def cancel_processing(self) -> None:
        """Signal the background thread to stop."""
        self._cancel_flag.set()

    def cancel_downloads(self) -> None:
        """Signal the download thread to stop."""
        self._cancel_downloads_flag.set()

    def select_download_folder(self) -> str:
        """Open native folder dialog for download destination. Returns selected path or empty string."""
        if not self._window:
            return ""
        try:
            result = self._window.create_file_dialog(webview.FileDialog.FOLDER)
            if result and len(result) > 0:
                return result[0]
            return ""
        except Exception as exc:
            msg = str(exc) if exc else "Unknown error"
            raise RuntimeError(f"Folder picker failed: {msg}") from exc

    def add_from_urls(self, urls_json: str, download_folder: str) -> None:
        """
        Download PDFs from URLs sequentially and add to queue via callbacks.

        Runs in background thread. Calls __onDownloadProgress, __onDownloadFileComplete
        per file, __onDownloadComplete when done, __onDownloadError on failure.
        """
        if not download_folder or not os.path.isdir(download_folder):
            self._push_js(
                "window.__onDownloadError(" + json.dumps("Download folder is required.") + ")"
            )
            return

        try:
            urls = json.loads(urls_json)
        except json.JSONDecodeError:
            self._push_js(
                "window.__onDownloadError(" + json.dumps("Invalid URL list.") + ")"
            )
            return

        if not isinstance(urls, list):
            urls = [urls]

        urls = [str(u).strip() for u in urls if u]
        urls = list(dict.fromkeys(urls))  # deduplicate, preserve order

        if not urls:
            self._push_js(
                "window.__onDownloadError(" + json.dumps("No URLs provided.") + ")"
            )
            return

        self._cancel_downloads_flag.clear()
        self._downloading = True

        thread = threading.Thread(
            target=self._download_urls,
            args=(urls, download_folder),
            daemon=True,
        )
        thread.start()

    def start_processing(self, config_json: str) -> None:
        """
        Kick off splitting in a background thread.

        config_json fields:
            files:        list of file path strings
            splitMode:    "parts" | "pages" | "size"
            splitValue:   int (number of parts / max pages / target MB)
            compression:  str | null  ("low", "medium", "high", "maximum", or null)
            outputFolder: str
        """
        config = json.loads(config_json)
        self._cancel_flag.clear()
        self._processing = True

        thread = threading.Thread(target=self._process, args=(config,), daemon=True)
        thread.start()

    def start_download_and_process(self, config_json: str) -> None:
        """
        Download PDFs from URLs and process each immediately (download → process per file).

        config_json includes: urls, downloadFolder, outputFolder, splitMode, splitValue,
        compression, repairOnly, removeImages, workers.
        """
        config = json.loads(config_json)
        self._cancel_flag.clear()
        self._cancel_downloads_flag.clear()
        self._processing = True

        thread = threading.Thread(
            target=self._download_and_process,
            args=(config,),
            daemon=True,
        )
        thread.start()

    def start_unified_processing(self, config_json: str) -> None:
        """
        Process a mixed queue of local files and URLs. For each URL, download first then process.
        For each file, process directly. All use the same settings.
        Items added via add_items_to_current_run during processing are included in the current run.
        """
        config = json.loads(config_json)
        self._cancel_flag.clear()
        self._cancel_downloads_flag.clear()
        self._processing = True
        # Clear any stale items from a previous run
        while not self._pending_items_queue.empty():
            try:
                self._pending_items_queue.get_nowait()
            except queue.Empty:
                break

        thread = threading.Thread(
            target=self._unified_process,
            args=(config,),
            daemon=True,
        )
        thread.start()

    def add_items_to_current_run(self, items_json: str) -> None:
        """
        Add items to the currently running unified processing. No-op if not processing.
        items_json: JSON array of {type:"file",path} or {type:"url",url}.
        """
        if not self._processing:
            return
        try:
            items = json.loads(items_json)
        except json.JSONDecodeError:
            return
        if not isinstance(items, list):
            items = [items]
        for it in items:
            if isinstance(it, dict) and it.get("type") in ("file", "url"):
                self._pending_items_queue.put_nowait(it)

    # ------------------------------------------------------------------
    # Background download processing
    # ------------------------------------------------------------------
    def _download_urls(self, urls: list[str], download_folder: str) -> None:
        """Sequential download of URLs; push progress and per-file complete."""
        total = len(urls)
        last_dl_push: float = 0.0

        def cancel_check() -> bool:
            return self._cancel_downloads_flag.is_set()

        def make_progress_cb(idx: int, display_name: str):
            def progress_cb(bytes_received: int, total_bytes: int) -> None:
                nonlocal last_dl_push
                now = time.time()
                if (now - last_dl_push) < self.PROGRESS_THROTTLE and total_bytes > 0:
                    return
                last_dl_push = now
                percent = (
                    round(100 * bytes_received / total_bytes)
                    if total_bytes > 0
                    else -1
                )
                payload = json.dumps({
                    "currentFile": idx + 1,
                    "totalFiles": total,
                    "filename": display_name,
                    "bytesReceived": bytes_received,
                    "totalBytes": total_bytes,
                    "percent": percent,
                })
                self._push_js(f"window.__onDownloadProgress({payload})")
            return progress_cb

        try:
            for current_idx, url in enumerate(urls):
                if cancel_check():
                    self._push_js("window.__onDownloadComplete()")
                    break

                parsed = urlparse(url)
                display_name = unquote(os.path.basename(parsed.path)) or "document.pdf"
                if not display_name.lower().endswith(".pdf"):
                    display_name += ".pdf"

                try:
                    path = download_pdf(
                        url,
                        download_folder,
                        progress_cb=make_progress_cb(current_idx, display_name),
                        cancel_check=cancel_check,
                    )
                    info = dict(analyze(path))
                    self._push_js(
                        f"window.__onDownloadFileComplete({json.dumps(info)})"
                    )
                except InterruptedError:
                    self._push_js("window.__onDownloadComplete()")
                    break
                except Exception as exc:
                    self._push_js(
                        f"window.__onDownloadError({json.dumps(f'Failed to download {url}: {exc}')})"
                    )
                    continue

            if not cancel_check():
                self._push_js("window.__onDownloadComplete()")
        finally:
            self._downloading = False

    def _push_download_phase(
        self,
        current_file: int,
        total_files: int,
        filename: str,
        bytes_received: int,
        total_bytes: int,
    ) -> None:
        """Push progress for download phase during download-and-process flow."""
        percent = (
            round(100 * bytes_received / total_bytes)
            if total_bytes > 0
            else 0
        )
        payload = json.dumps({
            "phase": "download",
            "currentFile": current_file,
            "totalFiles": total_files,
            "filename": filename,
            "bytesReceived": bytes_received,
            "totalBytes": total_bytes,
            "percent": percent,
        })
        self._push_js(f"window.__onPhaseProgress({payload})")

    def _download_and_process(self, config: dict) -> None:
        """Pipeline: for each URL, download then process immediately."""
        urls = config.get("urls", [])
        if not urls:
            self._push_error("No URLs provided.")
            self._processing = False
            return

        download_folder = config.get("downloadFolder", "")
        if not download_folder or not os.path.isdir(download_folder):
            self._push_error("Download folder is required.")
            self._processing = False
            return

        output_folder = config.get("outputFolder", "")
        if not output_folder:
            self._push_error("Output folder is required.")
            self._processing = False
            return

        os.makedirs(output_folder, exist_ok=True)

        # Build process config (same structure as start_processing)
        process_config = {
            "splitMode": config.get("splitMode", "parts"),
            "splitValue": int(config.get("splitValue", 4)),
            "compression": config.get("compression"),
            "outputFolder": output_folder,
            "workers": min(8, max(1, int(config.get("workers", 2)))),
            "removeImages": bool(config.get("removeImages", False)),
            "repairOnly": bool(config.get("repairOnly", False)),
        }
        if process_config["compression"] in ("none", ""):
            process_config["compression"] = None

        split_mode = process_config["splitMode"]
        split_value = process_config["splitValue"]
        compression = process_config["compression"]
        workers = process_config["workers"]
        remove_images = process_config["removeImages"]
        repair_only = process_config["repairOnly"]

        total_files = len(urls)
        completed_files = 0
        all_outputs: list[str] = []
        start_time = time.time()
        last_dl_push: float = 0.0

        def cancel_check() -> bool:
            return self._cancel_flag.is_set() or self._cancel_downloads_flag.is_set()

        def make_dl_progress_cb(idx: int, name: str):
            def cb(br: int, tb: int) -> None:
                nonlocal last_dl_push
                now = time.time()
                if tb > 0 and (now - last_dl_push) < self.PROGRESS_THROTTLE:
                    return
                last_dl_push = now
                self._push_download_phase(idx + 1, total_files, name, br, tb)
            return cb

        try:
            for file_idx, url in enumerate(urls):
                if cancel_check():
                    self._push_error("Processing cancelled.")
                    break

                parsed = urlparse(url)
                display_name = unquote(os.path.basename(parsed.path)) or "document.pdf"
                if not display_name.lower().endswith(".pdf"):
                    display_name += ".pdf"

                # Phase 1: Download
                try:
                    path = download_pdf(
                        url,
                        download_folder,
                        progress_cb=make_dl_progress_cb(file_idx, display_name),
                        cancel_check=cancel_check,
                    )
                except InterruptedError:
                    self._push_error("Processing cancelled.")
                    break
                except Exception as exc:
                    self._push_error(f"Failed to download {url}: {exc}")
                    continue

                filename = os.path.basename(path)

                # Phase 2: Process
                self._last_progress_push = 0.0
                self._push_js(
                    f"window.__onPhaseProgress({json.dumps({'phase': 'process', 'currentFile': file_idx + 1, 'totalFiles': total_files, 'filename': filename})})"
                )

                def make_progress_cb(fname: str):
                    def progress_cb(
                        cur_page: int,
                        tot_pages: int,
                        cur_part: int,
                        tot_parts: int,
                        status: str,
                        **kwargs: Any,
                    ) -> None:
                        self._push_progress(
                            cur_page, tot_pages,
                            cur_part, tot_parts,
                            status,
                        )
                    return progress_cb

                def on_compress_part_start(part_index: int) -> None:
                    self._push_compress_part_start(part_index)

                def on_compress_progress(
                    part_index: int,
                    tmp_size: int,
                    input_size: int,
                    estimated_output: int,
                ) -> None:
                    self._push_compress_progress(
                        part_index, tmp_size, input_size, estimated_output
                    )

                on_part_start = on_compress_part_start if (compression and workers > 1) else None
                on_progress = on_compress_progress if compression else None

                try:
                    if split_mode == "parts":
                        outputs = split_by_parts(
                            path, split_value, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                            repair_only=repair_only,
                        )
                    elif split_mode == "pages":
                        outputs = split_by_max_pages(
                            path, split_value, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    elif split_mode == "size":
                        target_bytes = split_value * 1024 * 1024
                        outputs = split_by_target_size(
                            path, target_bytes, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    else:
                        self._push_error(f"Unknown split mode: {split_mode}")
                        continue

                    all_outputs.extend(outputs)
                    completed_files += 1
                    self._push_file_complete(
                        filename,
                        [os.path.basename(o) for o in outputs],
                    )
                except InterruptedError:
                    self._push_error("Processing cancelled.")
                    break
                except Exception as exc:
                    self._push_error(f"Error processing {filename}: {exc}")
                    continue

            elapsed = round(time.time() - start_time, 1)
            self._push_all_complete({
                "completedFiles": completed_files,
                "totalFiles": total_files,
                "totalParts": len(all_outputs),
                "elapsedSeconds": elapsed,
                "cancelled": cancel_check(),
            })
        finally:
            self._processing = False

    def _unified_process(self, config: dict) -> None:
        """Process mixed items: URLs are downloaded first, then all items processed in order."""
        items = config.get("items", [])
        if not items:
            self._push_error("No files or URLs to process.")
            self._processing = False
            return

        download_folder = config.get("downloadFolder", "")
        output_folder = config.get("outputFolder", "")
        has_urls = any(it.get("type") == "url" for it in items)

        if has_urls and (not download_folder or not os.path.isdir(download_folder)):
            self._push_error("Download folder is required for URL items.")
            self._processing = False
            return

        if not output_folder:
            self._push_error("Output folder is required.")
            self._processing = False
            return

        os.makedirs(output_folder, exist_ok=True)

        process_config = {
            "splitMode": config.get("splitMode", "parts"),
            "splitValue": int(config.get("splitValue", 4)),
            "compression": config.get("compression"),
            "outputFolder": output_folder,
            "workers": min(8, max(1, int(config.get("workers", 2)))),
            "removeImages": bool(config.get("removeImages", False)),
            "repairOnly": bool(config.get("repairOnly", False)),
        }
        if process_config["compression"] in ("none", ""):
            process_config["compression"] = None

        split_mode = process_config["splitMode"]
        split_value = process_config["splitValue"]
        compression = process_config["compression"]
        workers = process_config["workers"]
        remove_images = process_config["removeImages"]
        repair_only = process_config["repairOnly"]

        to_process: deque = deque(list(items))
        total_files = len(items)
        completed_files = 0
        file_idx = 0
        all_outputs: list[str] = []
        start_time = time.time()
        last_dl_push: float = 0.0

        def cancel_check() -> bool:
            return self._cancel_flag.is_set() or self._cancel_downloads_flag.is_set()

        def drain_pending() -> None:
            nonlocal total_files
            while True:
                try:
                    extra = self._pending_items_queue.get_nowait()
                    to_process.append(extra)
                    total_files += 1
                except queue.Empty:
                    break

        def make_dl_progress_cb(idx: int, tot: int, name: str):
            def cb(br: int, tb: int) -> None:
                nonlocal last_dl_push
                now = time.time()
                if tb > 0 and (now - last_dl_push) < self.PROGRESS_THROTTLE:
                    return
                last_dl_push = now
                self._push_download_phase(idx + 1, tot, name, br, tb)
            return cb

        try:
            while to_process:
                if cancel_check():
                    self._push_error("Processing cancelled.")
                    break

                item = to_process.popleft()
                file_idx = completed_files
                drain_pending()

                item_type = item.get("type", "file")
                path: str | None = None

                if item_type == "url":
                    url = item.get("url", "")
                    if not url:
                        continue
                    parsed = urlparse(url)
                    display_name = unquote(os.path.basename(parsed.path)) or "document.pdf"
                    if not display_name.lower().endswith(".pdf"):
                        display_name += ".pdf"
                    try:
                        path = download_pdf(
                            url,
                            download_folder,
                            progress_cb=make_dl_progress_cb(file_idx, total_files, display_name),
                            cancel_check=cancel_check,
                        )
                    except InterruptedError:
                        self._push_error("Processing cancelled.")
                        break
                    except Exception as exc:
                        self._push_error(f"Failed to download {url}: {exc}")
                        continue
                else:
                    path = item.get("path", "")

                if not path or not os.path.isfile(path):
                    self._push_error(f"File not found: {path}")
                    continue

                filename = os.path.basename(path)

                self._last_progress_push = 0.0
                self._push_js(
                    f"window.__onPhaseProgress({json.dumps({'phase': 'process', 'currentFile': file_idx + 1, 'totalFiles': total_files, 'filename': filename})})"
                )

                def make_progress_cb(fname: str):
                    def progress_cb(
                        cur_page: int,
                        tot_pages: int,
                        cur_part: int,
                        tot_parts: int,
                        status: str,
                        **kwargs: Any,
                    ) -> None:
                        self._push_progress(
                            cur_page, tot_pages,
                            cur_part, tot_parts,
                            status,
                        )
                    return progress_cb

                def on_compress_part_start(part_index: int) -> None:
                    self._push_compress_part_start(part_index)

                def on_compress_progress(
                    part_index: int,
                    tmp_size: int,
                    input_size: int,
                    estimated_output: int,
                ) -> None:
                    self._push_compress_progress(
                        part_index, tmp_size, input_size, estimated_output
                    )

                on_part_start = on_compress_part_start if (compression and workers > 1) else None
                on_progress = on_compress_progress if compression else None

                try:
                    if split_mode == "parts":
                        outputs = split_by_parts(
                            path, split_value, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                            repair_only=repair_only,
                        )
                    elif split_mode == "pages":
                        outputs = split_by_max_pages(
                            path, split_value, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    elif split_mode == "size":
                        target_bytes = split_value * 1024 * 1024
                        outputs = split_by_target_size(
                            path, target_bytes, output_folder,
                            compression=compression,
                            progress_cb=make_progress_cb(filename),
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    else:
                        self._push_error(f"Unknown split mode: {split_mode}")
                        continue

                    all_outputs.extend(outputs)
                    completed_files += 1
                    self._push_file_complete(
                        filename,
                        [os.path.basename(o) for o in outputs],
                    )
                except InterruptedError:
                    self._push_error("Processing cancelled.")
                    break
                except Exception as exc:
                    self._push_error(f"Error processing {filename}: {exc}")
                    continue

            elapsed = round(time.time() - start_time, 1)
            self._push_all_complete({
                "completedFiles": completed_files,
                "totalFiles": total_files,
                "totalParts": len(all_outputs),
                "elapsedSeconds": elapsed,
                "cancelled": cancel_check(),
            })
        finally:
            self._processing = False

    # ------------------------------------------------------------------
    # Background processing
    # ------------------------------------------------------------------
    def _process(self, config: dict) -> None:
        files: list[str] = config["files"]
        split_mode: str = config["splitMode"]
        split_value: int = int(config["splitValue"])
        compression: str | None = config.get("compression")
        output_folder: str = config["outputFolder"]
        workers: int = min(8, max(1, int(config.get("workers", 2))))
        remove_images: bool = bool(config.get("removeImages", False))
        repair_only: bool = bool(config.get("repairOnly", False))

        if compression == "none" or compression == "":
            compression = None

        os.makedirs(output_folder, exist_ok=True)

        total_files = len(files)
        completed_files = 0
        all_outputs: list[str] = []
        start_time = time.time()

        def cancel_check() -> bool:
            return self._cancel_flag.is_set()

        try:
            for file_idx, file_path in enumerate(files):
                if cancel_check():
                    self._push_error("Processing cancelled.")
                    break

                filename = os.path.basename(file_path)

                # Push a "starting file" message
                self._last_progress_push = 0.0  # reset throttle for new file
                self._push_progress(0, 1, 0, 1, f"Starting {filename}...")

                def make_progress_cb(fname: str):
                    def progress_cb(
                        cur_page: int,
                        tot_pages: int,
                        cur_part: int,
                        tot_parts: int,
                        status: str,
                        **kwargs: Any,
                    ) -> None:
                        self._push_progress(
                            cur_page, tot_pages,
                            cur_part, tot_parts,
                            status,
                        )
                    return progress_cb

                progress_cb = make_progress_cb(filename)

                def on_compress_part_start(part_index: int) -> None:
                    self._push_compress_part_start(part_index)

                def on_compress_progress(
                    part_index: int,
                    tmp_size: int,
                    input_size: int,
                    estimated_output: int,
                ) -> None:
                    self._push_compress_progress(
                        part_index, tmp_size, input_size, estimated_output
                    )

                on_part_start = on_compress_part_start if (compression and workers > 1) else None
                on_progress = on_compress_progress if compression else None

                try:
                    if split_mode == "parts":
                        outputs = split_by_parts(
                            file_path, split_value, output_folder,
                            compression=compression,
                            progress_cb=progress_cb,
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                            repair_only=repair_only,
                        )
                    elif split_mode == "pages":
                        outputs = split_by_max_pages(
                            file_path, split_value, output_folder,
                            compression=compression,
                            progress_cb=progress_cb,
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    elif split_mode == "size":
                        target_bytes = split_value * 1024 * 1024  # MB → bytes
                        outputs = split_by_target_size(
                            file_path, target_bytes, output_folder,
                            compression=compression,
                            progress_cb=progress_cb,
                            cancel_check=cancel_check,
                            compression_workers=workers,
                            on_compress_part_start=on_part_start,
                            on_compress_progress=on_progress,
                            remove_images=remove_images,
                        )
                    else:
                        self._push_error(f"Unknown split mode: {split_mode}")
                        continue

                    all_outputs.extend(outputs)
                    completed_files += 1
                    self._push_file_complete(
                        filename,
                        [os.path.basename(o) for o in outputs],
                    )
                except InterruptedError:
                    self._push_error("Processing cancelled.")
                    break
                except Exception as exc:
                    self._push_error(f"Error processing {filename}: {exc}")
                    continue

            elapsed = round(time.time() - start_time, 1)
            self._push_all_complete({
                "completedFiles": completed_files,
                "totalFiles": total_files,
                "totalParts": len(all_outputs),
                "elapsedSeconds": elapsed,
                "cancelled": self._cancel_flag.is_set(),
            })
        finally:
            self._processing = False
