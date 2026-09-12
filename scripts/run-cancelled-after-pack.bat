@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:cancelled-after-pack >> logs\scheduled-cancelled-after-pack.log
call npm run sync:cancelled-after-pack >> logs\scheduled-cancelled-after-pack.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:cancelled-after-pack with exit code %SYNC_EXIT% >> logs\scheduled-cancelled-after-pack.log
exit /b %SYNC_EXIT%
