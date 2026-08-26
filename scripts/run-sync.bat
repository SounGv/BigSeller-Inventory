@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:inventory >> logs\scheduled-sync.log
call npm run sync:inventory >> logs\scheduled-sync.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:inventory with exit code %SYNC_EXIT% >> logs\scheduled-sync.log
exit /b %SYNC_EXIT%
