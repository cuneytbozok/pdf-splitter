"""
PDF Splitter – Desktop App
Entry point: launches a pywebview window serving the frontend UI.
"""

from __future__ import annotations

import os
import sys
import webview

from backend.api import Api

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")


def on_loaded(window: webview.Window, api: Api) -> None:
    """Called when the webview finishes loading the page."""
    try:
        api.setup_native_drop(window)
    except Exception as e:
        print(f"[warning] Could not set up native drag-and-drop: {e}")


def main() -> None:
    api = Api()
    window = webview.create_window(
        title="PDF Splitter",
        url=os.path.join(FRONTEND_DIR, "index.html"),
        js_api=api,
        width=900,
        height=740,
        min_size=(700, 600),
        text_select=False,
    )
    # Give the API a reference to the window so it can push progress to JS
    api.set_window(window)

    # Register the native drop handler once the page loads
    window.events.loaded += lambda: on_loaded(window, api)

    webview.start(debug=("--debug" in sys.argv))


if __name__ == "__main__":
    main()
