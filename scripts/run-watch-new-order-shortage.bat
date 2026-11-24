@echo off
rem 10-minute watch: new unconfirmed orders vs pick-position stock, announced to the LINE group.
rem   npm run watch:new-order-shortage
rem Needs a valid BigSeller session (keep-alive task). If it is expired the script says so once a day and stops - no automated re-login, by policy.
rem Keep this file ASCII only: cmd misreads other characters in comments.
cd /d "%~dp0.."
if not exist logs mkdir logs
set RUNLOG=%TEMP%\shortage-watch-%RANDOM%.log
call npm run watch:new-order-shortage > "%RUNLOG%" 2>&1
set WATCH_EXIT=%errorlevel%
rem drop the chatty network debug lines, and only keep a log entry that says something
findstr /v /c:"[net-debug]" "%RUNLOG%" >> logs\scheduled-shortage-watch.log
del "%RUNLOG%" >nul 2>&1
exit /b %WATCH_EXIT%
