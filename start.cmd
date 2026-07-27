@echo off
setlocal

REM Toreroflow: bring up everything the desktop app needs, in order.
REM
REM The installed app is a window that talks to a local API on port 4700. It
REM does not carry its own database or backend, so without this running it
REM shows "API offline" and nothing works. Double click this before opening
REM Toreroflow, and leave the window open while you use the app.

cd /d "%~dp0"

echo.
echo   Toreroflow
echo   ==========
echo.

REM --- 1. Docker, which holds the database and the job queue ---------------
echo   [1/4] Starting the database and queue...
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker is not running. Start Docker Desktop, wait for it to say
  echo   "Engine running", then run this again.
  echo.
  pause
  exit /b 1
)

docker compose -f infra/docker-compose.yml up -d
if errorlevel 1 (
  echo.
  echo   Could not start the containers. The message above says why.
  echo.
  pause
  exit /b 1
)

REM Postgres accepts connections a moment after the container starts, so
REM migrating too early fails with a connection error that looks alarming
REM and is not. Wait for it to actually answer.
echo   [2/4] Waiting for the database to answer...
set /a tries=0
:waitloop
docker exec toreroflow-postgres pg_isready -U toreroflow >nul 2>&1
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 30 (
  echo.
  echo   The database did not answer within 30 seconds. Check Docker Desktop.
  echo.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto waitloop
:ready

REM --- 2. Migrations, so a pulled update reaches the database --------------
REM Pulling new code that added a table does nothing until this runs, and the
REM symptom is a confusing 500 rather than an obvious missing table.
echo   [3/4] Applying any new database changes...
call pnpm --filter @toreroflow/db migrate:deploy
if errorlevel 1 (
  echo.
  echo   A database migration failed. Do not use the app until this is fixed,
  echo   the message above says what went wrong.
  echo.
  pause
  exit /b 1
)

REM --- 3. The API and the background worker -------------------------------
echo   [4/4] Starting the API and the background worker...
start "Toreroflow API" cmd /k "cd /d %~dp0 && pnpm dev:api"
start "Toreroflow worker" cmd /k "cd /d %~dp0 && pnpm --filter @toreroflow/worker dev"

echo.
echo   Two windows have opened, one for the API and one for the worker.
echo   Leave them running. Open Toreroflow now.
echo.
echo   To stop everything later, close those two windows and run stop.cmd.
echo.
pause
