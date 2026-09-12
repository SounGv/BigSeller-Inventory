@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:warehouse-stock-count >> logs\scheduled-warehouse-stock-count.log
call npm run sync:warehouse-stock-count >> logs\scheduled-warehouse-stock-count.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:warehouse-stock-count with exit code %SYNC_EXIT% >> logs\scheduled-warehouse-stock-count.log
exit /b %SYNC_EXIT%
