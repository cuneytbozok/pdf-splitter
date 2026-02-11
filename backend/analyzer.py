"""
Quick PDF analyzer – extracts metadata without fully loading every page.
"""

from __future__ import annotations

import os
from typing import TypedDict

import pikepdf

from backend.compressor import gs_available, repair_pdf


class PdfInfo(TypedDict):
    path: str
    name: str
    pages: int
    size_bytes: int
    size_human: str
    status: str  # "ok" | "needs_repair" | "error"
    error: str


def _human_size(nbytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(nbytes) < 1024:
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024  # type: ignore[assignment]
    return f"{nbytes:.1f} TB"


def analyze(path: str) -> PdfInfo:
    """
    Return page count, file size and health status for a PDF.

    If the PDF fails to open, attempts a Ghostscript repair and reports
    the status accordingly.
    """
    name = os.path.basename(path)
    size_bytes = os.path.getsize(path)
    size_human = _human_size(size_bytes)

    first_err: Exception | None = None

    # Try opening directly
    try:
        pdf = pikepdf.open(path)
        pages = len(pdf.pages)
        pdf.close()
        return PdfInfo(
            path=path,
            name=name,
            pages=pages,
            size_bytes=size_bytes,
            size_human=size_human,
            status="ok",
            error="",
        )
    except Exception as exc:
        first_err = exc

    # Try with GS repair
    if gs_available():
        repaired = path + ".tmp_analyze_repair.pdf"
        try:
            repair_pdf(path, repaired)
            pdf = pikepdf.open(repaired)
            pages = len(pdf.pages)
            pdf.close()
            return PdfInfo(
                path=path,
                name=name,
                pages=pages,
                size_bytes=size_bytes,
                size_human=size_human,
                status="needs_repair",
                error="",
            )
        except Exception:
            pass
        finally:
            if os.path.exists(repaired):
                try:
                    os.remove(repaired)
                except OSError:
                    pass

    return PdfInfo(
        path=path,
        name=name,
        pages=0,
        size_bytes=size_bytes,
        size_human=size_human,
        status="error",
        error=str(first_err) if first_err else "Unknown error",
    )
