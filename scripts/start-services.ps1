# Boots everything Toreroflow needs: Docker (Postgres + Redis), the API,
# the media worker, and the captions service. Safe to run repeatedly; it
# only starts what isn't already running.

$ErrorActionPreference = "SilentlyContinue"
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:TEMP "toreroflow-logs"
New-Item -ItemType Directory -Force $logDir | Out-Null

function Test-Port([int]$port) {
  return Test-NetConnection -ComputerName localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
}

# 1. Docker engine
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Starting Docker Desktop..."
  Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  $deadline = (Get-Date).AddSeconds(180)
  do {
    Start-Sleep -Seconds 5
    docker info *> $null
  } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
}
docker compose -f (Join-Path $repo "infra\docker-compose.yml") up -d | Out-Null
Write-Host "Postgres + Redis: up"

# 2. API (:4700)
if (-not (Test-Port 4700)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command",
    "Set-Location '$repo'; pnpm run dev:api *> '$logDir\api.log'"
  Write-Host "API: starting"
} else {
  Write-Host "API: already running"
}

# 3. Media worker (no port; detect by launcher command line)
$worker = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "powershell.exe" -and $_.CommandLine -match "toreroflow/worker"
}
if (-not $worker) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command",
    "Set-Location '$repo'; pnpm --filter @toreroflow/worker dev *> '$logDir\worker.log'"
  Write-Host "Worker: starting"
} else {
  Write-Host "Worker: already running"
}

# 4. Captions service (:4710)
if (-not (Test-Port 4710)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command",
    "Set-Location '$repo\apps\captions'; .\.venv\Scripts\python.exe -m uvicorn main:app --port 4710 *> '$logDir\captions.log'"
  Write-Host "Captions: starting"
} else {
  Write-Host "Captions: already running"
}

Write-Host "All services launched. Logs: $logDir"
