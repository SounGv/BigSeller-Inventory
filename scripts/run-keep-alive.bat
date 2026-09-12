@echo off
REM Long-running wrapper for Task Scheduler (AtLogOn trigger) — unlike
REM run-sync.bat this never "finishes"; it launches session-keeper.ts and
REM lets it run indefinitely, appending to its own log file. See
REM scripts/session-keeper.ts for what this actually does and why.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting keep-alive >> logs\scheduled-keep-alive.log
call npm run keep-alive >> logs\scheduled-keep-alive.log 2>&1
echo [%date% %time%] keep-alive exited with code %errorlevel% (session expired or was stopped — needs manual "npm run login:bigseller" then restart) >> logs\scheduled-keep-alive.log
