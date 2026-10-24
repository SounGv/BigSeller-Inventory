# Run in an ELEVATED PowerShell (same as the other install-*.ps1 here):
#   powershell -ExecutionPolicy Bypass -File .\install-push-orders-task.ps1
# Registers ONE Task Scheduler entry that runs run-push-processing-orders.bat every 10 minutes from 07:00 for 12 hours,
# every day. Needs the BigSeller session kept valid (npm run keep-alive); with an expired session the run logs it and
# exits non-zero, and the GV Catalog page shows the age of the last good copy.

$scriptsDir = $PSScriptRoot
$batPath = Join-Path $scriptsDir "run-push-processing-orders.bat"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Daily -At "07:00"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "07:00" -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Hours 12)).Repetition
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "BigSeller-Push-ProcessingOrders" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Pushes the latest BigSeller processing orders to GV Catalog every 10 minutes (carton-label page)" `
  -Force | Out-Null

Write-Host "Installed: BigSeller-Push-ProcessingOrders (every 10 minutes, 07:00-19:00)"
