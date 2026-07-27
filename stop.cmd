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

REM "stop" rather than "down" on purpose. Both keep your data, which lives in
REM named volumes either way, but "down" deletes the containers themselves,
REM so they disappear from Docker Desktop entirely and look lost. "stop"
REM leaves them sitting there, stopped, and start.cmd brings them back faster
REM because there is nothing to recreate.
docker compose -f infra/docker-compose.yml stop

echo.
echo   Stopped. The containers are still listed in Docker Desktop, just not
echo   running, and your data is untouched. Run start.cmd when you next need
echo   the app.
echo.
pause
