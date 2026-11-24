@echo off
rem Full BigSeller sync used by the transfer-bill flow (LINE bot "ใบย้าย สร้าง" refuses data older than 120 min):
rem   npm run sync:bigseller  -> DB_LOCATION_CURRENT / DB_LOCATION_SNAPSHOT + DB_SKU_INVENTORY + SYNC_LOG "combined sync complete"
rem Keep this file ASCII only: cmd misreads other characters in comments.
rem Needs a valid BigSeller session (keep-alive task). If the session is expired it logs that and stops - no automated re-login, by policy.
cd /d "%~dp0.."
if not exist logs mkdir logs
set RUNLOG=%TEMP%\bigseller-full-sync-%RANDOM%.log
echo [%date% %time%] Starting sync:bigseller >> logs\scheduled-sync-bigseller.log
call npm run sync:bigseller > "%RUNLOG%" 2>&1
set SYNC_EXIT=%errorlevel%
rem drop the very chatty network debug lines so the log stays small
findstr /v /c:"[net-debug]" "%RUNLOG%" >> logs\scheduled-sync-bigseller.log
del "%RUNLOG%" >nul 2>&1
echo [%date% %time%] Finished sync:bigseller with exit code %SYNC_EXIT% >> logs\scheduled-sync-bigseller.log
exit /b %SYNC_EXIT%
