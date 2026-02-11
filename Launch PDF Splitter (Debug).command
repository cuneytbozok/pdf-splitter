#!/bin/bash
# Run PDF Splitter from Terminal so you can see any error messages

cd "$(dirname "$0")"
echo "Starting PDF Splitter..."
python3 main.py
echo ""
echo "App closed. Press Enter to exit."
read
