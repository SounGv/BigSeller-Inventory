@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:order-funnel >> logs\scheduled-order-funnel.log
call npm run sync:order-funnel >> logs\scheduled-order-funnel.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:order-funnel with exit code %SYNC_EXIT% >> logs\scheduled-order-funnel.log
exit /b %SYNC_EXIT%
