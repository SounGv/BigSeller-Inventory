@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:sales-summary >> logs\scheduled-sales-summary.log
call npm run sync:sales-summary >> logs\scheduled-sales-summary.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:sales-summary with exit code %SYNC_EXIT% >> logs\scheduled-sales-summary.log
exit /b %SYNC_EXIT%
