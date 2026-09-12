@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync:operator-wave-ranking >> logs\scheduled-operator-wave-ranking.log
call npm run sync:operator-wave-ranking >> logs\scheduled-operator-wave-ranking.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished sync:operator-wave-ranking with exit code %SYNC_EXIT% >> logs\scheduled-operator-wave-ranking.log
exit /b %SYNC_EXIT%
