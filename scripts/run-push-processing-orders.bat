@echo off
rem Sends the latest processing orders to GV Catalog (carton-label page). Used by the scheduled task and by hand.
chcp 65001 >nul
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting push-processing-orders >> logs\push-orders.log
call npx tsx scripts/push-processing-orders.ts >> logs\push-orders.log 2>&1
set EXIT_CODE=%errorlevel%
echo [%date% %time%] Finished with exit code %EXIT_CODE% >> logs\push-orders.log
exit /b %EXIT_CODE%
