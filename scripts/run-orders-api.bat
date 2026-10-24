@echo off
rem Starts the local orders API (carton-label page "ซิงค์จาก BigSeller"). Leave this window open while staff use the page.
chcp 65001 >nul
cd /d "%~dp0.."
call npx tsx scripts/orders-api-server.ts
pause
