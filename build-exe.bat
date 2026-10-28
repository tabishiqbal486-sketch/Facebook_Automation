@echo off
REM Builds FurnitureAssistant.exe (Windows). Needs Node.js 20+ and internet the first time.
cd /d "%~dp0"
call npx --yes @yao-pkg/pkg . --targets node20-win-x64 --output release\FurnitureAssistant.exe
if errorlevel 1 goto :err
copy /Y .env.example release\.env.example >nul
echo.
echo Done. Open the "release" folder. Copy .env.example to .env, fill it in, then double-click FurnitureAssistant.exe
echo Your data is kept in a "data" folder next to the exe.
pause
exit /b 0
:err
echo Build failed. Read the message above.
pause
exit /b 1
