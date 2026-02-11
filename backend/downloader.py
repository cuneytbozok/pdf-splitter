"""
Download PDF files from HTTP/HTTPS URLs with progress support.
"""

from __future__ import annotations

import re
import os
from typing import Callable, Optional
from urllib.parse import unquote, urlparse

import requests

# Optional max size (500 MB) to avoid runaway downloads
MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024

CHUNK_SIZE = 64 * 1024  # 64 KB for progress callbacks


def _is_valid_url(url: str) -> bool:
    """Validate that URL is http or https."""
    try:
        parsed = urlparse(url)
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except Exception:
        return False


def _extract_filename(url: str, response: requests.Response) -> str:
    """Extract filename from Content-Disposition header or URL path."""
    # Content-Disposition: attachment; filename="document.pdf"
    cd = response.headers.get("Content-Disposition")
    if cd:
        match = re.search(r'filename\s*=\s*(?:"([^"]+)"|\'([^\']+)\'|([^;\s]+))', cd, re.I)
        if match:
            name = match.group(1) or match.group(2) or match.group(3) or ""
            if name and name.lower().endswith(".pdf"):
                return name
            if name:
                return name + ("" if name.lower().endswith(".pdf") else ".pdf")

    # URL path segment
    path = urlparse(url).path
    if path:
        name = os.path.basename(unquote(path))
        if name:
            return name + ("" if name.lower().endswith(".pdf") else ".pdf")

    return "downloaded.pdf"


def download_pdf(
    url: str,
    dest_dir: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> str:
    """
    Download a PDF from a valid http/https URL to dest_dir.

    Returns the local file path. Raises ValueError for invalid URL or on failure.

    progress_cb(bytes_received, total_bytes) - total_bytes is -1 if unknown
    cancel_check() - returns True to stop the download
    """
    if not _is_valid_url(url):
        raise ValueError(f"Invalid URL (must be http or https): {url}")

    os.makedirs(dest_dir, exist_ok=True)

    # No timeout - download runs until complete or user cancels
    response = requests.get(url, stream=True, allow_redirects=True)

    response.raise_for_status()

    content_length = response.headers.get("Content-Length")
    total_bytes = int(content_length) if content_length else -1

    if total_bytes > 0 and total_bytes > MAX_DOWNLOAD_SIZE:
        raise ValueError(
            f"File too large ({total_bytes / (1024 * 1024):.1f} MB). Max allowed: {MAX_DOWNLOAD_SIZE / (1024 * 1024):.0f} MB."
        )

    filename = _extract_filename(url, response)
    dest_path = os.path.join(dest_dir, filename)

    # Handle duplicate filenames
    base, ext = os.path.splitext(filename)
    counter = 1
    while os.path.exists(dest_path):
        dest_path = os.path.join(dest_dir, f"{base}_{counter}{ext}")
        counter += 1

    bytes_received = 0

    with open(dest_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
            if cancel_check and cancel_check():
                f.close()
                if os.path.exists(dest_path):
                    os.remove(dest_path)
                raise InterruptedError("Download cancelled by user")

            if chunk:
                f.write(chunk)
                bytes_received += len(chunk)

                if progress_cb:
                    progress_cb(bytes_received, total_bytes)

                if total_bytes > 0 and bytes_received > MAX_DOWNLOAD_SIZE:
                    f.close()
                    if os.path.exists(dest_path):
                        os.remove(dest_path)
                    raise ValueError(
                        f"File exceeded max size ({MAX_DOWNLOAD_SIZE / (1024 * 1024):.0f} MB)."
                    )

    return dest_path
