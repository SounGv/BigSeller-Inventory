@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:order-stock-check >> logs\scheduled-order-stock-check.log
call npm run sync:order-stock-check >> logs\scheduled-order-stock-check.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:order-stock-check with exit code %SYNC_EXIT% >> logs\scheduled-order-stock-check.log
exit /b %SYNC_EXIT%
