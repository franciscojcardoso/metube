$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location $root
$env:HOST = '127.0.0.1'
$env:PORT = '8082'
$userDownloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
$metubeFolder = Join-Path $userDownloads 'Metube'
$env:DOWNLOAD_DIR = $metubeFolder
$env:STATE_DIR = Join-Path $root 'state'
$env:TEMP_DIR = Join-Path $root 'temp'
$env:TRANSCRIPTION_URL = 'http://127.0.0.1:9002/v1/audio/transcriptions'
$env:TRANSCRIPTION_API_KEY = 'metube-local-whisper'
$env:TRANSCRIPTION_MODEL = 'whisper-1'
$env:TRANSCRIPTION_TIMEOUT = '7200'

New-Item -ItemType Directory -Force $env:DOWNLOAD_DIR, $env:STATE_DIR, $env:TEMP_DIR | Out-Null

$legacyDownloads = Join-Path $root 'downloads'
if (Test-Path $legacyDownloads) {
  Get-ChildItem -Path $legacyDownloads -File | ForEach-Object {
    $dest = Join-Path $env:DOWNLOAD_DIR $_.Name
    if (-not (Test-Path $dest)) {
      Move-Item -Path $_.FullName -Destination $dest -Force
    }
  }
}
& docker start metube-transcricao-whisper 2>$null | Out-Null
if (-not (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue)) {
  $env:LOG_FILE = Join-Path $env:STATE_DIR 'metube.log'
  Start-Process -FilePath (Join-Path $root '.venv\Scripts\pythonw.exe') -ArgumentList 'app\main.py' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
Start-Process 'http://127.0.0.1:8082'
