@echo off
REM Long-running wrapper for Task Scheduler (AtLogOn trigger) -- like
REM run-keep-alive.bat, this never "finishes"; it launches the wave-engine
REM daemon (urgent loop ~3 min, main loop ~12 min) and lets it run
REM indefinitely, appending to its own log file. WAVE_ENGINE_LIVE_PRIORITIES
REM is intentionally left unset here, so every cycle stays dry-run -- it scans
REM and logs decisions but clicks nothing. See ONBOARDING.md section 1 before
REM ever setting that variable.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting wave-engine (dry-run) >> logs\scheduled-wave-engine.log
call npm run wave-engine >> logs\scheduled-wave-engine.log 2>&1
echo [%date% %time%] wave-engine exited with code %errorlevel% (session likely expired -- check BigSeller-KeepAlive task, then restart) >> logs\scheduled-wave-engine.log
