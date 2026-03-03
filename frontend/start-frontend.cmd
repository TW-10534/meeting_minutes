@echo off
echo ═══════════════════════════════════════════
echo   MM Zettai — Starting Frontend Proxy
echo ═══════════════════════════════════════════
echo.

cd /d "%~dp0"

if not exist "venv" (
    echo [1/2] Creating virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo [2/2] Installing dependencies...
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

echo Starting frontend proxy on port 8003...
echo Access the app at: http://localhost:8003
echo.
python app.py
