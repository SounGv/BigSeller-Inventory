# Registers ONE Task Scheduler entry that runs the full BigSeller sync (run-sync-bigseller.bat) during working hours.
# Same pattern as install-stock-value-sync-task.ps1. If registering from a normal window fails with
# "Access is denied", run this in an ELEVATED PowerShell instead:
#   powershell -ExecutionPolicy Bypass -File .\install-sync-bigseller-task.ps1
#
# Schedule: Monday-Saturday, first run 08:30, then every 2 hours until about 18:30 (08:30, 10:30, 12:30, 14:30, 16:30, 18:30).
# Every 2 hours (not hourly): the old hourly "BigSeller Inventory Sync" task was disabled after BigSeller kept rejecting the
# automated session, and the LINE transfer flow only needs data younger than 120 minutes.
# Times avoid the GV-CancelReport-Auto slots (08:00, 11:00, 13:00, 15:00, 17:40) and the 07:00 stock-value sync.
# Needs the PC on and Gadgetvilla logged in (the browser is headed) and a valid BigSeller session (keep-alive task).

$scriptsDir = $PSScriptRoot
$batPath = Join-Path $scriptsDir "run-sync-bigseller.bat"
$taskName = "BigSeller-Sync-Full"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At "08:30"
# Add the repetition (every 2 h for 10 h) by borrowing it from a throw-away -Once trigger.
$rep = (New-ScheduledTaskTrigger -Once -At "08:30" -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Hours 10)).Repetition
$trigger.Repetition = $rep
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs run-sync-bigseller.bat Mon-Sat 08:30 and every 2 h until 18:30 - full BigSeller sync (location + SKU inventory) for the LINE transfer-bill flow. Log: logs\scheduled-sync-bigseller.log" `
  -Force | Out-Null

Write-Host "Installed: $taskName (Mon-Sat 08:30, every 2 h until 18:30)"
Get-ScheduledTask -TaskName $taskName | Format-Table TaskName, State

Write-Host ""
Write-Host "To remove later:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
