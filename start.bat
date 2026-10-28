@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org ^(version 20 or newer^), install it, then run this file again.
  pause
  exit /b 1
)
node src\server.js
pause
