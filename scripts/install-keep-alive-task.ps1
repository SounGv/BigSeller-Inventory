# Run this file in an ELEVATED PowerShell (right-click PowerShell -> "Run as
# Administrator", then: powershell -ExecutionPolicy Bypass -File .\install-keep-alive-task.ps1
# from this scripts\ folder) — Claude Code's own sandbox has no permission to
# register scheduled tasks, so this has to be run manually once by a human.
#
# What it does: registers a Task Scheduler entry that launches
# run-keep-alive.bat at every Windows logon, which in turn runs
# `npm run keep-alive` (scripts/session-keeper.ts) indefinitely in the
# background — see that file for what it actually does. This requires a
# valid playwright/.auth/bigseller.json already on disk (run
# `npm run login:bigseller` at least once first, manually, before or after
# installing this task).

$batPath = Join-Path $PSScriptRoot 'run-keep-alive.bat'

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "BigSeller-KeepAlive" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "Keeps the BigSeller browser session alive (pings every ~8 min) so sync scripts do not need repeated manual re-login. See BigSeller-Inventory/scripts/session-keeper.ts. Requires a valid playwright/.auth/bigseller.json from a prior 'npm run login:bigseller'." `
  -Force

Write-Host "Installed. Starting it now so it's active immediately (not just on next logon)..."
Start-ScheduledTask -TaskName "BigSeller-KeepAlive"
Get-ScheduledTask -TaskName "BigSeller-KeepAlive" | Format-List TaskName, State
Write-Host "Logs will accumulate at BigSeller-Inventory\logs\scheduled-keep-alive.log"
Write-Host "To remove later: Unregister-ScheduledTask -TaskName 'BigSeller-KeepAlive' -Confirm:`$false"
