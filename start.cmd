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

REM --- 0. Make node and pnpm findable -------------------------------------
REM A script launched from Explorer inherits a narrower PATH than a terminal
REM does. npm installs its global binaries, pnpm among them, into a folder
REM that is often missing from it, so this failed with "pnpm is not
REM recognized" while the same command worked fine when typed by hand.
REM
REM Both the migration below and the two windows opened at the end need
REM pnpm, so this is fixed once here and inherited by everything after it.
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%APPDATA%\npm" set "PATH=%APPDATA%\npm;%PATH%"

where pnpm >nul 2>&1
if errorlevel 1 (
  echo.
  echo   pnpm was not found, so the app cannot be started.
  echo.
  echo   Install it by opening a terminal and running:
  echo       npm install -g pnpm
  echo.
  echo   If it is already installed, it is somewhere this script does not
  echo   look. Run "where pnpm" in a terminal and tell me the path.
  echo.
  pause
  exit /b 1
)

REM --- 1. Docker, which holds the database and the job queue ---------------
echo   [1/3] Starting the database and queue...
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker is not running. Start Docker Desktop, wait for it to say
  echo   "Engine running", then run this again.
  echo.
  pause
  exit /b 1
)

REM Postgres accepts connections a moment after its container starts, so
REM migrating immediately fails with a connection error that looks alarming
REM and is not. --wait holds until both services report healthy, using the
REM healthchecks already declared in the compose file.
REM
REM An earlier version polled with "docker exec pg_isready" instead. It hung:
REM docker exec attaches to the container, and from a double clicked script
REM with no console attached that can block forever rather than returning a
REM failure the loop could count. Compose already knows when a service is
REM ready, so asking it beats re-implementing the question.
docker compose -f infra/docker-compose.yml up -d --wait --wait-timeout 60
if errorlevel 1 (
  echo.
  echo   The database and queue did not come up healthy within 60 seconds.
  echo   Open Docker Desktop and check the toreroflow containers.
  echo.
  pause
  exit /b 1
)

REM --- 2. Migrations, so a pulled update reaches the database --------------
REM Pulling new code that added a table does nothing until this runs, and the
REM symptom is a confusing 500 rather than an obvious missing table.
echo   [2/3] Applying any new database changes...
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
echo   [3/3] Starting the API and the background worker...
start "Toreroflow API" cmd /k "cd /d %~dp0 && pnpm dev:api"
start "Toreroflow worker" cmd /k "cd /d %~dp0 && pnpm --filter @toreroflow/worker dev"

echo.
echo   Two windows have opened, one for the API and one for the worker.
echo   Leave them running. Open Toreroflow now.
echo.
echo   To stop everything later, close those two windows and run stop.cmd.
echo.
pause
