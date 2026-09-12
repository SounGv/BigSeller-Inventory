@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:best-sellers >> logs\scheduled-best-sellers.log
call npm run sync:best-sellers >> logs\scheduled-best-sellers.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:best-sellers with exit code %SYNC_EXIT% >> logs\scheduled-best-sellers.log
exit /b %SYNC_EXIT%
