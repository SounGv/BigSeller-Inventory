# Run this file in an ELEVATED PowerShell (right-click PowerShell -> "Run as
# Administrator", then: powershell -ExecutionPolicy Bypass -File .\install-wave-engine-task.ps1
# from this scripts\ folder) -- Claude Code's own sandbox has no permission to
# register scheduled tasks, so this has to be run manually once by a human.
#
# What it does: registers a Task Scheduler entry that launches
# run-wave-engine.bat at every Windows logon, which in turn runs
# `npm run wave-engine` (the daemon: urgent loop ~3 min, main loop ~12 min)
# indefinitely in the background -- see scripts/wave-engine.ts.
#
# Dry-run only: WAVE_ENGINE_LIVE_PRIORITIES is not set anywhere in this task,
# so it scans and logs every cycle but never clicks. Turning any priority
# live is a separate, deliberate step (see ONBOARDING.md section 1) -- do not
# add that env var here.
#
# Requires BigSeller-KeepAlive to actually be running (not just installed) --
# the wave-engine daemon only reads the session file, it never refreshes it.
# Check with: Get-ScheduledTaskInfo -TaskName "BigSeller-KeepAlive"

$batPath = Join-Path $PSScriptRoot 'run-wave-engine.bat'

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "BigSeller-WaveEngine" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs the BigSeller WaveEngine daemon (dry-run only -- scans order queue and wave candidates, logs every decision, clicks nothing) so the report in report/ stays fresh without a human starting it by hand. See BigSeller-Inventory/BigSeller-WaveEngine/ONBOARDING.md. Requires BigSeller-KeepAlive to be actively running." `
  -Force

Write-Host "Installed. Starting it now so it's active immediately (not just on next logon)..."
Start-ScheduledTask -TaskName "BigSeller-WaveEngine"
Get-ScheduledTask -TaskName "BigSeller-WaveEngine" | Format-List TaskName, State
Write-Host "Logs will accumulate at BigSeller-Inventory\logs\scheduled-wave-engine.log"
Write-Host "To remove later: Unregister-ScheduledTask -TaskName 'BigSeller-WaveEngine' -Confirm:`$false"
