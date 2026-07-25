@echo off
title Toreroflow
echo Starting Toreroflow services...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-services.ps1"

set "APP=%LOCALAPPDATA%\Toreroflow\toreroflow.exe"
if not exist "%APP%" set "APP=%~dp0..\apps\desktop\src-tauri\target\release\toreroflow.exe"
if exist "%APP%" (
  echo Launching Toreroflow...
  start "" "%APP%"
) else (
  echo Could not find toreroflow.exe. Run the installer first.
  pause
)
