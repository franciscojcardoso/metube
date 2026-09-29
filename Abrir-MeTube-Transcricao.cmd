@echo off
setlocal
cd /d "%~dp0"
set "HOST=127.0.0.1"
set "PORT=8082"
set "DOWNLOAD_DIR=%USERPROFILE%\Downloads\Metube"
set "STATE_DIR=%~dp0state"
set "TEMP_DIR=%~dp0temp"
set "TRANSCRIPTION_URL=http://127.0.0.1:9002/v1/audio/transcriptions"
set "TRANSCRIPTION_API_KEY=metube-local-whisper"
set "TRANSCRIPTION_MODEL=whisper-1"
set "TRANSCRIPTION_TIMEOUT=7200"
set "LOG_FILE=%STATE_DIR%\metube.log"

if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"
if exist "%~dp0downloads" (
  robocopy "%~dp0downloads" "%DOWNLOAD_DIR%" /mov /e >nul 2>&1
)

docker start metube-transcricao-whisper >nul 2>&1
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar o Whisper. Abra o Docker Desktop e tente novamente.
  pause
  exit /b 1
)

for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue).OwningProcess"') do set "METUBE_PID=%%P"
if not defined METUBE_PID start "MeTube Transcricao" /b ".venv\Scripts\pythonw.exe" "app\main.py"

timeout /t 3 /nobreak >nul
start "MeTube Transcricao" "http://127.0.0.1:8082"
