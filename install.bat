@echo off
REM ============================================================
REM  Web Intel - One-click installer for Windows
REM  Creates .env, installs Node deps + Playwright Chromium,
REM  pulls Ollama model, checks MongoDB.
REM  No API keys required - fully offline.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   Web Intel - Installer
echo   Offline stack: Ollama (gemma4:e2b) + MongoDB + Next.js
echo   Features: User auth, chat UI, web crawler, anti-hallucination
echo ============================================================
echo.

REM ---- 1. Node.js check ----
echo [1/6] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo   [ERROR] Node.js not found.
    echo   Install Node 18+ from https://nodejs.org then re-run this script.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo   Node.js found: !NODEV!

REM ---- 2. Create .env file ----
echo.
echo [2/6] Creating .env configuration...
if exist ".env" (
    echo   .env already exists - keeping your settings.
) else (
    > ".env" (
        echo # Web Intel - Environment Configuration
        echo # No API keys required - runs fully offline.
        echo.
        echo # Ollama (local LLM server^)
        echo OLLAMA_HOST=http://localhost:11434
        echo.
        echo # Ollama model tag ^(pull with: ollama pull gemma4:e2b^)
        echo OLLAMA_MODEL=gemma4:e2b
        echo.
        echo # MongoDB connection string
        echo MONGODB_URI=mongodb://localhost:27017
        echo.
        echo # MongoDB database name
        echo MONGODB_DB=webintel
    )
    echo   .env created with default local settings (no API keys).
)

REM ---- 3. npm install ----
echo.
echo [3/6] Installing npm dependencies...
echo   (includes Next.js, React, Playwright, bcryptjs, MongoDB driver, etc.^)
call npm install
if errorlevel 1 (
    echo   [ERROR] npm install failed.
    echo   Try deleting node_modules and package-lock.json, then re-run.
    pause
    exit /b 1
)
echo   Dependencies installed successfully.

REM ---- 4. Playwright Chromium ----
echo.
echo [4/6] Installing Playwright Chromium (for JS-rendered pages)...
call npx playwright install chromium
if errorlevel 1 (
    echo   [WARN] Playwright Chromium install had an issue.
    echo   JS-rendered pages will fall back to static fetch. Continuing.
) else (
    echo   Chromium installed.
)

REM ---- 5. Ollama + model ----
echo.
echo [5/6] Checking Ollama and pulling model 'gemma4:e2b'...
where ollama >nul 2>nul
if errorlevel 1 (
    echo   [WARN] Ollama CLI not found on PATH.
    echo   Download from https://ollama.com and re-run this script.
    echo   The app will not be able to answer questions without Ollama.
) else (
    echo   Ollama found. Pulling gemma4:e2b...
    echo   (this downloads ~1.6 GB on first run - please be patient^)
    ollama pull gemma4:e2b
    if errorlevel 1 (
        echo   [WARN] Could not pull gemma4:e2b. Make sure Ollama is running.
    ) else (
        echo   Model gemma4:e2b is ready.
    )
)

REM ---- 6. MongoDB check ----
echo.
echo [6/6] Checking MongoDB...
where mongod >nul 2>nul
if errorlevel 1 (
    echo   [WARN] mongod not found on PATH.
    echo   MongoDB is required for:
    echo     - User accounts and login
    echo     - Saving conversation history
    echo   Install from https://www.mongodb.com/try/download/community
    echo   Or edit .env to point MONGODB_URI to a remote database.
    echo   The app will run but you cannot log in or save conversations.
) else (
    echo   mongod found. Make sure the MongoDB service is running
    echo   or use run.bat which starts it automatically.
)

REM ---- Summary ----
echo.
echo ============================================================
echo   Install complete!
echo.
echo   What was set up:
echo     .env              - local config (no API keys)
echo     node_modules      - all dependencies (incl. bcryptjs for auth)
echo     Playwright        - Chromium browser for JS-rendered pages
echo     Ollama model      - gemma4:e2b for offline LLM inference
echo.
echo   What you need:
echo     MongoDB installed - for user accounts and history
echo     Ollama running    - for AI answers
echo.
echo   Next: double-click run.bat to start the app.
echo   The app opens at http://localhost:3000
echo   You will be asked to create an account on first visit.
echo ============================================================
pause
endlocal