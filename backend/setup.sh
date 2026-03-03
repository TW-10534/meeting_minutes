#!/bin/bash
# MM Zettai - Backend Setup Script
# Run this on the GPU server to install dependencies

set -e

echo "═══════════════════════════════════════════"
echo "  MM Zettai — Meeting System Backend Setup"
echo "═══════════════════════════════════════════"

cd "$(dirname "$0")"

# Create virtual environment if needed
if [ ! -d "venv" ]; then
    echo "[1/3] Creating Python virtual environment..."
    python3 -m venv venv
fi

echo "[2/3] Installing dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "[3/3] Creating data directories..."
mkdir -p data recordings

echo ""
echo "Setup complete. Run ./start.sh to start the backend."
