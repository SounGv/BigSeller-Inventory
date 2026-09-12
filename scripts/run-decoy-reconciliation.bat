@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting reconcile:decoy-warehouse >> logs\scheduled-decoy-reconciliation.log
call npm run reconcile:decoy-warehouse >> logs\scheduled-decoy-reconciliation.log 2>&1
set SYNC_EXIT=%errorlevel%
echo [%date% %time%] Finished reconcile:decoy-warehouse with exit code %SYNC_EXIT% >> logs\scheduled-decoy-reconciliation.log
exit /b %SYNC_EXIT%
