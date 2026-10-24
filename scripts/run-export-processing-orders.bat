@echo off
rem Reads the processing orders of the store that needs carton labels (default "GV ส่งเอง")
rem and writes output\processing-orders.json for the GV Catalog "ใบแปะลังจากออเดอร์" page.
rem Needs a valid BigSeller session (npm run login:bigseller). Read-only on BigSeller.
chcp 65001 >nul
cd /d "%~dp0.."
call npx tsx scripts/export-processing-orders.ts %*
echo.
pause
