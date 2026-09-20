@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell is required but was not found on this PC.
  pause
  exit /b 1
)

if not exist "%~dp0launcher.ps1" (
  echo launcher.ps1 is missing next to run.bat - cannot open the launcher.
  pause
  exit /b 1
)

start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0launcher.ps1"
exit /b 0
