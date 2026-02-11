"""
Ghostscript compression and repair wrapper.

Compression presets:
    /screen   – 72 DPI, smallest files  (Low)
    /ebook    – 150 DPI, good balance    (Medium)
    /printer  – 300 DPI, print-ready     (High)
    /prepress – highest quality           (Maximum)
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# Preset mapping  (label → Ghostscript value)
# ---------------------------------------------------------------------------
COMPRESSION_PRESETS: dict[str, str] = {
    "low": "/screen",
    "medium": "/ebook",
    "high": "/printer",
    "maximum": "/prepress",
}

CancelChecker = Callable[[], bool]
# Optional: called periodically during compression with the temp output path (to report size)
CompressionProgressCallback = Callable[[str], None]


def gs_available() -> bool:
    """Return True if Ghostscript (gs) is found on PATH."""
    return shutil.which("gs") is not None


def _gs_path() -> str:
    path = shutil.which("gs")
    if path is None:
        raise FileNotFoundError(
            "Ghostscript (gs) is not installed or not on PATH. "
            "Install it via: brew install ghostscript  (macOS) / "
            "apt install ghostscript  (Linux) / "
            "https://ghostscript.com/releases/  (Windows)"
        )
    return path


def _run_gs(
    cmd: list[str],
    cancel_check: Optional[CancelChecker] = None,
    tmp_path: Optional[str] = None,
    progress_cb: Optional[CompressionProgressCallback] = None,
) -> None:
    """
    Run a Ghostscript command with cancellation support.

    Uses Popen + polling so we can check the cancel flag periodically
    and kill the process if the user cancels.
    If tmp_path and progress_cb are set, progress_cb(tmp_path) is called
    every 2 seconds so the UI can show the growing output file size.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    last_progress = 0.0
    try:
        while True:
            try:
                proc.wait(timeout=0.5)
                break  # process finished
            except subprocess.TimeoutExpired:
                pass

            now = time.time()
            if tmp_path and progress_cb and (now - last_progress) >= 2.0:
                last_progress = now
                try:
                    progress_cb(tmp_path)
                except Exception:
                    pass

            # Check cancellation
            if cancel_check and cancel_check():
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                raise InterruptedError("Ghostscript cancelled by user")

        if proc.returncode != 0:
            stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
            raise subprocess.CalledProcessError(proc.returncode, cmd, stderr=stderr.encode())
    except InterruptedError:
        raise
    except Exception:
        # Make sure process is dead on any unexpected error
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        raise


def compress_pdf(
    input_pdf: str,
    preset: str = "medium",
    cancel_check: Optional[CancelChecker] = None,
    progress_cb: Optional[CompressionProgressCallback] = None,
) -> None:
    """
    Rewrite *input_pdf* in-place using Ghostscript with the given preset.

    *preset* is one of: low, medium, high, maximum
    If *progress_cb* is set, it is called periodically with the temp output path
    so the UI can show the growing file size.
    """
    gs_setting = COMPRESSION_PRESETS.get(preset)
    if gs_setting is None:
        raise ValueError(
            f"Unknown preset '{preset}'. "
            f"Choose from: {', '.join(COMPRESSION_PRESETS)}"
        )

    gs = _gs_path()
    tmp_out = input_pdf + ".tmp_gs.pdf"

    cmd = [
        gs,
        "-o", tmp_out,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        f"-dPDFSETTINGS={gs_setting}",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        input_pdf,
    ]

    try:
        _run_gs(
            cmd,
            cancel_check=cancel_check,
            tmp_path=tmp_out,
            progress_cb=progress_cb,
        )
        os.replace(tmp_out, input_pdf)
    except InterruptedError:
        # Clean up temp on cancellation
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except OSError:
                pass
        raise
    except subprocess.CalledProcessError as exc:
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except OSError:
                pass
        stderr_text = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else str(exc.stderr)
        raise RuntimeError(
            f"Ghostscript compression failed: {stderr_text}"
        ) from exc


def repair_pdf(
    input_pdf: str,
    output_pdf: str,
    preset: str = "maximum",
    cancel_check: Optional[CancelChecker] = None,
) -> None:
    """
    Write a repaired/rewritten PDF to *output_pdf* without touching *input_pdf*.

    Uses the highest quality preset by default to preserve content.
    """
    gs_setting = COMPRESSION_PRESETS.get(preset, "/prepress")
    gs = _gs_path()

    cmd = [
        gs,
        "-o", output_pdf,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        f"-dPDFSETTINGS={gs_setting}",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        input_pdf,
    ]

    try:
        _run_gs(cmd, cancel_check=cancel_check)
    except InterruptedError:
        if os.path.exists(output_pdf):
            try:
                os.remove(output_pdf)
            except OSError:
                pass
        raise
    except subprocess.CalledProcessError as exc:
        if os.path.exists(output_pdf):
            try:
                os.remove(output_pdf)
            except OSError:
                pass
        stderr_text = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else str(exc.stderr)
        raise RuntimeError(
            f"Ghostscript repair failed: {stderr_text}"
        ) from exc
