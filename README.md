# PDF Splitter

A local desktop app for splitting large PDF files into smaller parts. Built for people who need to break down massive PDFs (4000+ pages, 150–200 MB) into chunks that fit within the upload limits of AI tools like NotebookLM, ChatGPT Projects, Claude, Gemini Gems, and others.

---

## What It Does

- **Splits** large PDFs into multiple smaller files using three flexible modes
- **Compresses** output files using Ghostscript to reduce size further
- **Repairs** problematic PDFs automatically (malformed objects, circular references)
- **Repair only** — Fix PDF formatting without splitting or compressing (for PDFs rejected by NotebookLM, ChatGPT, etc.)
- **Remove images** — Strip images for faster compression and smaller files
- **Preserves** content — text, images, formatting all carry over to each split part
- **Add from URL** — Download PDFs from http/https URLs, then split or repair them
- **Unified queue** — Mix local files and URLs in one queue; one **Start Processing** handles everything
- **Add during processing** — You can add more URLs or files to the queue while a run is in progress; they are included in the current run
- **Open output folder** — Click the folder icon next to completed items to open the output directory in your file manager

### Add PDFs (URLs or drag & drop)

The input area has two panels side by side: **paste URLs** on the left, **drag & drop** on the right. Both feed into a single queue.

- **URLs** — Paste one or more PDF URLs (one per line or separated by spaces). Select a **download folder** for URL files, then click **Add to queue** to add them to the queue. URLs are downloaded when processing starts.
- **Local files** — Drag and drop PDFs or click to browse. Files are added to the queue immediately.
- **Start Processing** — Configure settings (split mode, compression, output folder), then click **Start Processing**. The app downloads any URL items first, then processes everything (local + downloaded) in order. One action for all items.

### Repair only

When a PDF is rejected by AI tools (NotebookLM, ChatGPT Projects, Claude, etc.) due to formatting errors, use **Repair only** in Settings. It rewrites the PDF in place — no split, no compression. Output files are saved as `filename_repaired.pdf` instead of `filename_part_1.pdf`. Works without Ghostscript.

### Remove images

Enable **Remove images** to strip all image XObjects from the PDF. This results in:
- **Smaller files** — Images often account for most of a PDF’s size
- **Faster compression** — Less data for Ghostscript to process when compression is enabled
- **Text-only output** — Useful when you only need the text for LLM ingestion

Can be combined with any split mode or Repair only.

### Split Modes

| Mode | Description | Example |
|---|---|---|
| **By number of parts** | Divide evenly into N files | Split a 4000-page PDF into 4 files of ~1000 pages each |
| **By max pages per file** | Each output file gets at most P pages | Each file has at most 500 pages |
| **By target file size** | Estimate page counts so each file stays under a size limit | Each file under 50 MB |

### Compression

You can choose **None** (no compression, no Ghostscript — split only) or one of the presets below. Presets use Ghostscript and rewrite the PDF; "None" skips that step entirely.

**Note:** More compression = smaller files. Less compression = larger files (higher quality). In PDF tools, "maximum quality" means minimal compression and largest files — not "maximum compression."

| Preset | Output size | Image DPI | Best for |
|---|---|---|---|
| High compression | Smallest files | 72 DPI | Maximum size reduction, screen reading |
| Medium compression | Balanced | 150 DPI | Good default for AI tool uploads |
| Low compression | Larger files | 300 DPI | When image quality matters |
| Minimal compression | Largest files | — | Best quality, near-original fidelity |

Compression presets require Ghostscript (see installation below). If Ghostscript is not installed, the app works fine — you just won't have compression or PDF repair (use "None" for split-only).

### Parallel compression

When compression is enabled, you can set **compression workers** (1–8). This is the maximum number of Ghostscript processes that run at the same time. The app **caps the worker count to the number of output parts** so you never set more workers than parts:

- **By number of parts** — Max workers = number of parts (e.g. 2 parts → 1 or 2 workers only).
- **By max pages per file** / **By target file size** — Max workers = largest number of parts among the selected files (based on their page count and your setting).

Example: if you split into 2 parts, only 2 workers can be used; if you split into 6 parts, you can use 1–6 workers (up to the 8 global limit). Each worker uses about **500 MB RAM** on average for large PDFs; the app shows an estimated peak RAM so you can stay within your system’s free memory.

---

## How It Works

The app runs as a native desktop window (not a browser tab) powered by:

- **pikepdf** — A fast, C++-backed PDF library (built on QPDF) that handles page-by-page splitting. Much faster and more robust than pure-Python alternatives, especially for large files.
- **pywebview** — Creates a native OS window with a web-based UI inside. On macOS it uses WebKit, on Windows it uses EdgeChromium, on Linux it uses GTK WebKit.
- **Ghostscript** (optional) — Industry-standard tool for PDF compression and repair. Called as an external process when compression is enabled.

### Processing Flow

1. Add PDFs — Paste URLs (click **Add to queue**) or drag & drop / browse local files. All go into one queue.
2. The app analyzes local files (page count, size, health check). URL items show as "Pending download".
3. Configure split mode, value, compression, output folder, and download folder (for URLs).
4. Click **Start Processing** — The app downloads any URL items, then processes all items in queue order (split or repair, then compress if enabled).
5. Output files are saved to your chosen folder as `filename_part_1.pdf`, `filename_part_2.pdf`, etc. (or `filename_repaired.pdf` when using Repair only).
6. Click the folder icon next to completed items to open the output folder in your file manager.

You can add more URLs or files during a run; they are processed as part of the current run. All processing happens locally. No files are uploaded anywhere.

---

## Requirements

### Python 3.10+

Check if Python is installed:

```bash
python3 --version
```

If not installed:
- **macOS**: `brew install python` or download from [python.org](https://www.python.org/downloads/)
- **Windows**: Download from [python.org](https://www.python.org/downloads/) (check "Add to PATH" during install)
- **Linux**: `sudo apt install python3 python3-pip` (Debian/Ubuntu) or `sudo dnf install python3 python3-pip` (Fedora)

### Ghostscript (optional, for compression & repair)

```bash
# macOS
brew install ghostscript

# Windows
# Download from https://ghostscript.com/releases/gsdnld.html
# Make sure 'gs' is on your PATH after install

# Linux (Debian/Ubuntu)
sudo apt install ghostscript

# Linux (Fedora)
sudo dnf install ghostscript
```

Verify it's installed:

```bash
gs --version
```

---

## Installation

1. **Clone or download** this project folder

2. **Install Python dependencies**:

```bash
cd "PDF Splitter"
pip3 install -r requirements.txt
```

This installs:
- `pikepdf` — PDF manipulation
- `pywebview` — Native desktop window
- `requests` — URL downloads with progress

That's it. No build step, no bundling, no Node.js.

---

## Usage

### Launch the app

```bash
python3 main.py
```

A native window will open with the app UI.

### Debug mode

To enable the WebKit developer console (useful for troubleshooting):

```bash
python3 main.py --debug
```

### Step-by-step

1. **Add files** — Paste PDF URLs in the URL field (select download folder, then click **Add to queue**), or drag & drop / browse local files. Both methods add to the same queue. You can mix URLs and local files.

2. **Review the queue** — Each item shows:
   - **Local files**: page count, size, and health status (Ready, Needs repair, or Error)
   - **URL items**: "Pending download" until processed

3. **Configure settings**:
   - **Download folder** — Where URL files are saved before processing (required if queue has URLs)
   - **Output folder** — Where split/repaired files are saved
   - **Repair only** — When enabled, fixes PDF formatting without splitting or compressing. Output: `filename_repaired.pdf`.
   - **Split mode** — By parts, by max pages, or by target file size
   - **Value** — Number of parts, max pages per file, or target size in MB
   - **Compression** — Preset or "None"
   - **Remove images** — Strip images for smaller files
   - **Compression workers** — 1–8 workers for parallel compression (max capped by number of parts)

4. **Start processing** — Click **Start Processing**. URL items download first, then all items are processed in order. You can add more URLs or files during the run — they join the current run. Progress shows:
   - Download progress (for URL items)
   - Per-file split/compress progress
   - Overall progress across all files

5. **Done** — Summary shows files split, parts created, and time elapsed. Click the **folder icon** next to completed items to open the output folder. Click "Process More Files" to start again.

You can **cancel** at any time — the app stops after the current operation.

---

## Project Structure

```
PDF Splitter/
├── main.py                  # Entry point — launches the app window
├── requirements.txt         # Python dependencies
├── README.md                # This file
├── backend/
│   ├── __init__.py
│   ├── api.py               # Bridge between frontend JS and Python backend
│   ├── splitter.py          # Core splitting engine (3 modes, progress callbacks)
│   ├── compressor.py        # Ghostscript compression wrapper (4 presets)
│   ├── analyzer.py          # PDF metadata reader (page count, size, health)
│   └── downloader.py        # URL download with streaming and progress
├── frontend/
│   ├── index.html           # App layout
│   ├── css/
│   │   └── styles.css       # UI styling (light + dark mode)
│   └── js/
│       └── app.js           # UI logic (drag-drop, progress, settings)
└── pdfsplit.py              # Original CLI script (kept for reference)
```

---

## Troubleshooting

### "Ghostscript not found" warning on startup

This is normal if you haven't installed Ghostscript. The app still works — you just can't use compression or auto-repair. Install it with:

```bash
brew install ghostscript    # macOS
sudo apt install ghostscript # Linux
```

### App window doesn't open

Make sure pywebview installed correctly. On Linux you may need additional system packages:

```bash
# Debian/Ubuntu
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1

# Fedora
sudo dnf install python3-gobject python3-cairo gtk3 webkit2gtk4.1
```

### Large PDFs are slow

This is expected for very large files (4000+ pages). The app processes pages one at a time to keep memory usage low. Compression with Ghostscript adds significant time per output file (several minutes for large parts). Tips:

- Choose **"None"** compression for fastest processing
- Use **compression workers** (2–4) when splitting into multiple parts — parallel compression can cut total time roughly in proportion to workers (e.g. 2 workers ≈ half the compression time). Ensure you have enough free RAM (~500 MB per worker).
- Split into fewer, larger parts if you don't need small files
- During splitting, the progress bar updates page-by-page. During compression, progress is estimated from the growing temp file size (Ghostscript doesn't report page-level progress). With multiple workers, you'll see which parts are compressing.

### "Error processing" toast

This usually means the PDF is severely corrupted. Try:

1. Make sure Ghostscript is installed (it enables auto-repair)
2. If repair fails, try opening the PDF in a viewer like Preview or Adobe Reader and re-saving it, then try again

---

## License

This project is for personal use. No warranty provided.
