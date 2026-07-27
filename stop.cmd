@echo off
setlocal

REM Stops the database and queue containers.
REM
REM The API and worker run in their own windows; close those first, or this
REM leaves them running and pointing at a database that has gone away, which
REM fills their logs with connection errors.

cd /d "%~dp0"

echo.
echo   Stopping the database and queue...
docker compose -f infra/docker-compose.yml down

echo.
echo   Stopped. Your data is kept, it lives in a Docker volume and survives
echo   this. Run start.cmd when you next need the app.
echo.
pause
