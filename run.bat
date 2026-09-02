@echo off
REM ============================================================
REM  Web Intel - One-click runner for Windows
REM  Starts: MongoDB (if needed), Ollama (if needed), then app.
REM  Opens http://localhost:3000 in your browser.
REM  You will be asked to log in or create an account.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   Web Intel - Starting
echo   Model: gemma4:e2b (offline)  ^|  DB: MongoDB  ^|  Auth: enabled
echo ============================================================
echo.

REM ---- Check .env exists ----
if not exist ".env" (
    echo   [ERROR] .env not found. Run install.bat first.
    pause
    exit /b 1
)

REM ---- 1. MongoDB ----
echo [1/3] Checking MongoDB...
powershell -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 27017); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
    echo   MongoDB not responding on port 27017. Starting mongod...
    where mongod >nul 2>nul
    if errorlevel 1 (
        echo   [ERROR] mongod not found on PATH.
        echo   MongoDB is required for login and conversation history.
        echo   Install MongoDB Community from https://www.mongodb.com/try/download/community
        echo   Or start it as a Windows service, then re-run this script.
        echo.
        echo   Press any key to continue without MongoDB (limited mode),
        echo   or Ctrl+C to exit.
        pause >nul
    ) else (
        if not exist "%~dp0data\db" mkdir "%~dp0data\db"
        start "MongoDB" /min mongod --dbpath "%~dp0data\db" --bind_ip 127.0.0.1 --port 27017
        echo   MongoDB starting... (running in background^)
        timeout /t 3 /nobreak >nul
    )
) else (
    echo   MongoDB is already running.
)

REM ---- 2. Ollama ----
echo.
echo [2/3] Checking Ollama...
powershell -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 11434); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
    echo   Ollama not responding on port 11434. Starting ollama serve...
    where ollama >nul 2>nul
    if errorlevel 1 (
        echo   [ERROR] ollama not found on PATH.
        echo   Install from https://ollama.com then re-run this script.
        echo   The app cannot answer questions without Ollama.
        pause
        exit /b 1
    )
    start "Ollama" /min ollama serve
    echo   Ollama starting... (running in background^)
    timeout /t 4 /nobreak >nul
    echo   Ensuring model is loaded...
    ollama pull gemma4:e2b >nul 2>nul
) else (
    echo   Ollama is already running.
)

REM ---- 3. Next.js app ----
echo.
echo [3/3] Starting Next.js app...
echo.
echo   =========================================================
echo     The app is starting at http://localhost:3000
echo     Your browser will open automatically.
echo.
echo     FIRST VISIT: You will see the login page.
echo     Click "Create account" to register a username and password.
echo     After that you can sign in each time you run the app.
echo.
echo     NOTE: The first question may take 1-3 minutes because
echo     the gemma4:e2b model runs locally and needs time to
echo     process the crawled content. Follow-up questions on
echo     the same site are faster.
echo.
echo     Press Ctrl+C in this window to stop the app.
echo   =========================================================
echo.

REM open browser after the server has time to start
start "" /b cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3000"

call npm run dev

REM If dev server exits, clean up background windows
echo.
echo App stopped. Cleaning up background services...
taskkill /fi "WindowTitle eq MongoDB" /f >nul 2>nul
taskkill /fi "WindowTitle eq Ollama" /f >nul 2>nul
echo Done.
endlocal