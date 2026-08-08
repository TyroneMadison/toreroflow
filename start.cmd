@echo off
setlocal

REM Toreroflow: the development stack.
REM
REM This used to be the thing you double clicked before opening the app,
REM because the app was a window talking to an API on this machine. That has
REM not been true since the move to the server: the installed app talks to
REM https://toreroflow-server.tail0aa167.ts.net over HTTPS and reads nothing
REM on this computer. No Docker, no database, no API, no ffmpeg. Just open
REM Toreroflow from the Start Menu.
REM
REM What is left here is the stack for WORKING ON the code: a local Postgres,
REM the API, and the background worker, so changes can be tried without
REM touching the live server and the real client data on it. That is the only
REM reason to run this.

cd /d "%~dp0"

echo.
echo   Toreroflow, development stack
echo   =============================
echo.
echo   You do not need this to use the app. The installed Toreroflow talks to
echo   the server on its own. Open it from the Start Menu and close this.
echo.
echo   Continue only if you are working on the code.
echo.
choice /c YN /n /m "   Start the development stack? [Y/N] "
if errorlevel 2 (
  echo.
  echo   Nothing started.
  echo.
  exit /b 0
)
echo.

REM --- 0. Make node and pnpm findable -------------------------------------
REM A script launched from Explorer inherits a narrower PATH than a terminal
REM does. npm installs its global binaries, pnpm among them, into a folder
REM that is often missing from it, so this failed with "pnpm is not
REM recognized" while the same command worked fine when typed by hand.
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%APPDATA%\npm" set "PATH=%APPDATA%\npm;%PATH%"

where pnpm >nul 2>&1
if errorlevel 1 (
  echo.
  echo   pnpm was not found, so the stack cannot start.
  echo.
  echo   Install it by opening a terminal and running:
  echo       npm install -g pnpm
  echo.
  pause
  exit /b 1
)

REM --- 1. Postgres, which holds the data and the job queues ----------------
REM One container now. Redis used to be the second and is gone: the queues run
REM on Postgres, which had to be here anyway.
echo   [1/3] Starting the local database...
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker is not running. Start Docker Desktop, wait for it to say
  echo   "Engine running", then run this again.
  echo.
  echo   If it is running but hanging: kill the Docker processes, run
  echo   "wsl --shutdown", rename %%LOCALAPPDATA%%\Docker\run, and relaunch.
  echo.
  pause
  exit /b 1
)

REM Postgres accepts connections a moment after its container starts, so
REM migrating immediately fails with a connection error that looks alarming
REM and is not. --wait holds until it reports healthy, using the healthcheck
REM already declared in the compose file.
REM
REM An earlier version polled with "docker exec pg_isready" instead. It hung:
REM docker exec attaches to the container, and from a double clicked script
REM with no console attached that can block forever rather than returning a
REM failure the loop could count. Compose already knows when a service is
REM ready, so asking it beats re-implementing the question.
docker compose -f infra/docker-compose.yml up -d --wait --wait-timeout 60
if errorlevel 1 (
  echo.
  echo   The database did not come up healthy within 60 seconds.
  echo   Open Docker Desktop and check the toreroflow-postgres container.
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
  echo   A database migration failed. The message above says what went wrong.
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
echo   Leave them running while you work.
echo.
echo   The installed app will NOT use them: it is pointed at the server. To
echo   point a build at this stack instead, set VITE_API_URL in .env to
echo   http://localhost:4700 and run "pnpm --filter @toreroflow/desktop dev".
echo.
echo   To stop everything later, close those two windows and run stop.cmd.
echo.
pause
