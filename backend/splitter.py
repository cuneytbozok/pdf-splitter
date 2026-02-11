"""
Core PDF splitting engine using pikepdf.

Supports three modes:
  1. By number of parts   – split into N roughly-equal files
  2. By max pages per file – each output has at most P pages
  3. By target file size   – estimate pages-per-part so each output stays under S bytes
"""

from __future__ import annotations

import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

import pikepdf

from backend.compressor import compress_pdf, repair_pdf, gs_available

# ---------------------------------------------------------------------------
# Type alias for the progress callback
# ---------------------------------------------------------------------------
# (current_page, total_pages, current_part, total_parts, status_message, **kwargs e.g. bytes_written)
ProgressCallback = Callable[..., None]

CancelChecker = Callable[[], bool]
# returns True when the user has requested cancellation

OnCompressPartStart = Callable[[int], None]
# called when a worker starts compressing part idx (1-based)

OnCompressProgress = Callable[[int, int, int, int], None]
# called periodically: (part_index_1based, tmp_size_bytes, input_size_bytes, estimated_output_bytes)

# Typical output/input ratios by preset (for progress estimation)
_COMPRESSION_OUTPUT_RATIO = {"low": 0.25, "medium": 0.4, "high": 0.6, "maximum": 0.9}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _compute_part_sizes(total: int, parts: int) -> list[int]:
    """Return a list of page-counts that sum to *total*, as equal as possible."""
    base, remainder = divmod(total, parts)
    return [base + (1 if i < remainder else 0) for i in range(parts)]


def _open_pdf(path: str) -> pikepdf.Pdf:
    """Open a PDF, attempting GS repair if it fails on first try."""
    try:
        return pikepdf.open(path)
    except Exception:
        if not gs_available():
            raise
        repaired = path + ".tmp_repaired.pdf"
        try:
            repair_pdf(path, repaired)
            return pikepdf.open(repaired)
        finally:
            if os.path.exists(repaired):
                try:
                    os.remove(repaired)
                except OSError:
                    pass


def _write_part(
    src: pikepdf.Pdf,
    start: int,
    end: int,
    out_path: str,
    progress_cb: Optional[ProgressCallback],
    cancel_check: Optional[CancelChecker],
    part_idx: int,
    total_parts: int,
    page_offset: int,
    total_pages: int,
) -> None:
    """Copy pages [start, end) from *src* into a new PDF at *out_path*."""
    dst = pikepdf.new()
    for i in range(start, end):
        if cancel_check and cancel_check():
            dst.close()
            if os.path.exists(out_path):
                os.remove(out_path)
            raise InterruptedError("Cancelled by user")
        dst.pages.append(src.pages[i])
        if progress_cb:
            progress_cb(
                page_offset + (i - start) + 1,
                total_pages,
                part_idx + 1,
                total_parts,
                f"Writing part {part_idx + 1}/{total_parts}",
            )
    dst.save(out_path)
    dst.close()


def _compress_one(
    out_path: str,
    compression: str,
    cancel_check: Optional[CancelChecker],
    progress_cb: Optional[ProgressCallback],
    total: int,
    idx: int,
    num_parts: int,
    page_offset: int,
    size: int,
    on_part_start: Optional[OnCompressPartStart] = None,
    on_compress_progress: Optional[OnCompressProgress] = None,
) -> None:
    """Compress a single part (used for parallel workers)."""
    if on_part_start:
        on_part_start(idx + 1)
    if progress_cb:
        progress_cb(
            page_offset + size, total,
            idx + 1, num_parts,
            f"Compressing part {idx + 1}/{num_parts}...",
        )

    input_size = os.path.getsize(out_path) if os.path.exists(out_path) else 1
    ratio = _COMPRESSION_OUTPUT_RATIO.get(compression, 0.5)
    estimated_output = max(1, int(input_size * ratio))

    def compression_progress(tmp_path: str) -> None:
        if on_compress_progress and os.path.exists(tmp_path):
            tmp_size = os.path.getsize(tmp_path)
            on_compress_progress(idx + 1, tmp_size, input_size, estimated_output)

    compress_pdf(
        out_path, compression,
        cancel_check=cancel_check,
        progress_cb=compression_progress if on_compress_progress else None,
    )


def _do_split(
    input_path: str,
    sizes: list[int],
    output_dir: str,
    *,
    compression: Optional[str] = None,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelChecker] = None,
    compression_workers: int = 1,
    on_compress_part_start: Optional[OnCompressPartStart] = None,
    on_compress_progress: Optional[OnCompressProgress] = None,
) -> list[str]:
    """
    Shared implementation: given pre-computed *sizes* (page counts per part),
    split the PDF and optionally compress each part.
    When compression_workers > 1, compression runs in parallel (multiple gs processes).
    """
    src = _open_pdf(input_path)
    total = len(src.pages)
    num_parts = len(sizes)
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    outputs: list[str] = []
    page_offset = 0
    start = 0

    # Phase 1: write all parts (no compression yet)
    for idx, size in enumerate(sizes):
        end = start + size
        out_path = os.path.join(output_dir, f"{base_name}_part_{idx + 1}.pdf")
        _write_part(
            src, start, end, out_path,
            progress_cb, cancel_check,
            idx, num_parts, page_offset, total,
        )
        if progress_cb:
            progress_cb(
                page_offset + size,
                total,
                idx + 1,
                num_parts,
                f"Part {idx + 1}/{num_parts} written",
            )
        outputs.append(out_path)
        page_offset += size
        start = end

    src.close()

    # Phase 2: compress (sequential or parallel)
    if not compression:
        return outputs

    workers = max(1, min(8, compression_workers))
    page_offsets = [0]
    for size in sizes[:-1]:
        page_offsets.append(page_offsets[-1] + size)

    if workers == 1:
        for idx, size in enumerate(sizes):
            if cancel_check and cancel_check():
                raise InterruptedError("Cancelled by user")
            out_path = outputs[idx]
            _compress_one(
                out_path, compression, cancel_check, progress_cb,
                total, idx, num_parts, page_offsets[idx], size,
                on_compress_progress=on_compress_progress,
            )
        return outputs

    # Parallel: run up to `workers` gs processes at a time
    parts_done = 0
    lock = threading.Lock()

    def on_part_done(_: object) -> None:
        nonlocal parts_done
        with lock:
            parts_done += 1
            if progress_cb:
                progress_cb(
                    total, total,
                    parts_done, num_parts,
                    f"Compressing ({parts_done} of {num_parts} parts done)...",
                )

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = []
        for idx, size in enumerate(sizes):
            if cancel_check and cancel_check():
                raise InterruptedError("Cancelled by user")
            out_path = outputs[idx]
            po = page_offsets[idx]
            fut = executor.submit(
                _compress_one,
                out_path, compression, cancel_check, None,
                total, idx, num_parts, po, size,
                on_part_start=on_compress_part_start,
                on_compress_progress=on_compress_progress,
            )
            fut.add_done_callback(on_part_done)
            futures.append(fut)

        for fut in as_completed(futures):
            if cancel_check and cancel_check():
                for f in futures:
                    f.cancel()
                raise InterruptedError("Cancelled by user")
            fut.result()  # raise any exception

    return outputs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def split_by_parts(
    input_path: str,
    num_parts: int,
    output_dir: str,
    *,
    compression: Optional[str] = None,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelChecker] = None,
    compression_workers: int = 1,
    on_compress_part_start: Optional[OnCompressPartStart] = None,
    on_compress_progress: Optional[OnCompressProgress] = None,
) -> list[str]:
    """Split *input_path* into *num_parts* files with roughly equal page counts."""
    src = _open_pdf(input_path)
    total = len(src.pages)
    src.close()

    if num_parts < 2:
        raise ValueError("Number of parts must be at least 2")
    if num_parts > total:
        raise ValueError(f"Number of parts ({num_parts}) exceeds total pages ({total})")

    sizes = _compute_part_sizes(total, num_parts)
    return _do_split(
        input_path, sizes, output_dir,
        compression=compression,
        progress_cb=progress_cb,
        cancel_check=cancel_check,
        compression_workers=compression_workers,
        on_compress_part_start=on_compress_part_start,
        on_compress_progress=on_compress_progress,
    )


def split_by_max_pages(
    input_path: str,
    max_pages: int,
    output_dir: str,
    *,
    compression: Optional[str] = None,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelChecker] = None,
    compression_workers: int = 1,
    on_compress_part_start: Optional[OnCompressPartStart] = None,
    on_compress_progress: Optional[OnCompressProgress] = None,
) -> list[str]:
    """Split so that each output file has at most *max_pages* pages."""
    src = _open_pdf(input_path)
    total = len(src.pages)
    src.close()

    if max_pages < 1:
        raise ValueError("Max pages must be at least 1")

    num_parts = math.ceil(total / max_pages)
    sizes = _compute_part_sizes(total, num_parts)
    return _do_split(
        input_path, sizes, output_dir,
        compression=compression,
        progress_cb=progress_cb,
        cancel_check=cancel_check,
        compression_workers=compression_workers,
        on_compress_part_start=on_compress_part_start,
        on_compress_progress=on_compress_progress,
    )


def split_by_target_size(
    input_path: str,
    target_bytes: int,
    output_dir: str,
    *,
    compression: Optional[str] = None,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_check: Optional[CancelChecker] = None,
    compression_workers: int = 1,
    on_compress_part_start: Optional[OnCompressPartStart] = None,
    on_compress_progress: Optional[OnCompressProgress] = None,
) -> list[str]:
    """
    Split so that each output file is approximately under *target_bytes*.

    Strategy: estimate average bytes-per-page from the source file size,
    compute pages-per-part, then split by that page count.
    """
    file_size = os.path.getsize(input_path)
    src = _open_pdf(input_path)
    total = len(src.pages)
    src.close()

    if target_bytes < 1:
        raise ValueError("Target size must be positive")

    bytes_per_page = file_size / total if total > 0 else file_size
    pages_per_part = max(1, int(target_bytes / bytes_per_page))
    num_parts = math.ceil(total / pages_per_part)
    if num_parts < 1:
        num_parts = 1

    sizes = _compute_part_sizes(total, num_parts)
    return _do_split(
        input_path, sizes, output_dir,
        compression=compression,
        progress_cb=progress_cb,
        cancel_check=cancel_check,
        compression_workers=compression_workers,
        on_compress_part_start=on_compress_part_start,
        on_compress_progress=on_compress_progress,
    )
