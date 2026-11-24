# Registers ONE Task Scheduler entry that runs the shortage watch (run-watch-new-order-shortage.bat)
# every 10 minutes, Monday-Saturday, from 08:02 until 17:52 (the older routine's window).
# Registering a task needs an ELEVATED PowerShell (right-click -> Run as administrator):
#   powershell -ExecutionPolicy Bypass -File .\install-new-order-shortage-watch-task.ps1
#
# Same pattern as install-sync-bigseller-task.ps1. The script itself also checks the hours, and skips a
# round when the full sync is using the shared BigSeller session, so overlapping triggers are harmless.
# Needs the PC on, the Windows user logged in (the browser is headed) and a valid BigSeller session (keep-alive task).

$batPath = Join-Path $PSScriptRoot "run-watch-new-order-shortage.bat"
$taskName = "BigSeller-ShortageWatch"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At "08:02"
$rep = (New-ScheduledTaskTrigger -Once -At "08:02" -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Hours 9 -Minutes 50)).Repetition
$trigger.Repetition = $rep
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Every 10 min Mon-Sat 08:02-17:52: new unconfirmed orders vs pick-position stock; announces urgent-order shortages (once per SKU per day) to the LINE group. Log: logs\scheduled-shortage-watch.log" `
  -Force | Out-Null

Write-Host "Installed: $taskName (Mon-Sat 08:02, every 10 min until 17:52)"
Get-ScheduledTask -TaskName $taskName | Format-Table TaskName, State

Write-Host ""
Write-Host "To remove later:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
