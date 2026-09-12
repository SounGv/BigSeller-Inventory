@echo off
REM Double-click this file. It asks Windows for Administrator rights itself
REM (one "Yes" on the popup) and then runs install-wave-engine-task.ps1 --
REM no need to open PowerShell manually or find "Run as administrator".
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator rights - click "Yes" on the popup...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0install-wave-engine-task.ps1"
echo.
echo Done. Press any key to close this window.
pause >nul
