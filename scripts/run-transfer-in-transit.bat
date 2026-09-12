@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:transfer-in-transit >> logs\scheduled-transfer-in-transit.log
call npm run sync:transfer-in-transit >> logs\scheduled-transfer-in-transit.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:transfer-in-transit with exit code %SYNC_EXIT% >> logs\scheduled-transfer-in-transit.log
exit /b %SYNC_EXIT%
