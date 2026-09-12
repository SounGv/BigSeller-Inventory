@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:warehouse-backlog >> logs\scheduled-warehouse-backlog.log
call npm run sync:warehouse-backlog >> logs\scheduled-warehouse-backlog.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:warehouse-backlog with exit code %SYNC_EXIT% >> logs\scheduled-warehouse-backlog.log
exit /b %SYNC_EXIT%
