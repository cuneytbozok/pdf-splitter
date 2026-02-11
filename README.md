# PDF Splitter

A local desktop app for splitting large PDF files into smaller parts. Built for people who need to break down massive PDFs (4000+ pages, 150–200 MB) into chunks that fit within the upload limits of AI tools like NotebookLM, ChatGPT Projects, Claude, Gemini Gems, and others.

---

## What It Does

- **Splits** large PDFs into multiple smaller files using three flexible modes
- **Compresses** output files using Ghostscript to reduce size further
- **Repairs** problematic PDFs automatically (malformed objects, circular references)
- **Preserves** content — text, images, formatting all carry over to each split part

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

1. You drop or browse for PDF files
2. The app analyzes each file (page count, size, health check)
3. You configure split mode, value, compression, and output folder
4. Click Start — the app splits pages file by file with real-time progress
5. If compression is enabled, each output part is compressed (in parallel when workers > 1)
6. Output files are saved to your chosen folder as `filename_part_1.pdf`, `filename_part_2.pdf`, etc.

All processing happens locally on your machine. No files are uploaded anywhere.

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

1. **Add files** — Drag and drop PDF files onto the drop zone, or click it to browse. Drag-and-drop uses native OS support, so it works on macOS, Windows, and Linux. You can add multiple files.

2. **Review the queue** — Each file shows its page count, size, and health status:
   - **Ready** — File is healthy and ready to process
   - **Needs repair** — File has issues but can be auto-repaired (requires Ghostscript)
   - **Error** — File cannot be opened (will be skipped during processing)

3. **Configure settings**:
   - **Split mode** — Choose how you want to split (by parts, by max pages, or by target size)
   - **Value** — Enter the number of parts, max pages per file, or target size in MB
   - **Compression** — Pick a preset or choose "None" to skip compression
   - **Compression workers** — When compression is on, choose 1 to N (N is limited by the number of parts for your current split mode and files; max 8). More workers run compression in parallel and use more RAM (~500 MB per worker). The app shows estimated peak RAM.
   - **Output folder** — Click Browse to select where output files are saved

4. **Start processing** — Click the Start button. You'll see:
   - Per-file progress bar (page-based during split; estimated during compression)
   - Worker status when using multiple compression workers
   - Overall progress across all files
   - Status messages for each phase (splitting, compressing)

5. **Done** — A summary shows how many files were split, how many parts were created, and the total time elapsed. Click "Process More Files" to start again.

You can **cancel** at any time — the app stops after the current operation (page split or compression run) and cleans up.

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
│   └── analyzer.py          # PDF metadata reader (page count, size, health)
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
