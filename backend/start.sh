#!/bin/bash
# MM Zettai - Backend Startup Script
# Run this on the GPU server

set -e

echo "═══════════════════════════════════════════"
echo "  MM Zettai — Starting Meeting Backend"
echo "═══════════════════════════════════════════"

cd "$(dirname "$0")"
source venv/bin/activate

# Check if vLLM is running (shared with VT project)
if curl -s http://localhost:8018/v1/models > /dev/null 2>&1; then
    echo "[OK] vLLM is already running."
else
    echo "[!] vLLM is not running. Starting vLLM container..."
    docker compose up -d
    echo "Waiting for vLLM to be ready..."
    for i in $(seq 1 60); do
        if curl -s http://localhost:8018/v1/models > /dev/null 2>&1; then
            echo "[OK] vLLM is ready."
            break
        fi
        sleep 5
        echo "  Waiting... ($i/60)"
    done
fi

echo "Starting MM Zettai backend on port 8002..."
python app.py
