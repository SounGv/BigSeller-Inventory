@echo off
rem Checks every opted-in transfer document (DB_TRANSFER_TRACKING, trackDecision=yes) for a status
rem change or a stuck-too-long condition, and reports back via LINE only when there's something to say.
rem See src/services/transfer-status-check-service.ts. Keep this file ASCII only: cmd misreads other
rem characters in comments.
cd /d "%~dp0.."
if not exist logs mkdir logs
set "LOG=logs\scheduled-transfer-status-check.log"
echo [%date% %time%] ===== transfer-status check start >> "%LOG%"

call npm run check:transfer-status >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] ===== transfer-status check FAILED >> "%LOG%"
  exit /b 1
)

echo [%date% %time%] ===== transfer-status check done >> "%LOG%"
exit /b 0
