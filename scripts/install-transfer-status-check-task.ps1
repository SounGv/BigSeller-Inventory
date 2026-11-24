# Registers ONE Task Scheduler entry that checks opted-in transfer documents' status every 2 hours,
# 08:00-20:00. Same pattern as install-stock-value-sync-task.ps1. If registering from a normal window
# fails with "Access is denied", run this in an ELEVATED PowerShell instead:
#   powershell -ExecutionPolicy Bypass -File .\install-transfer-status-check-task.ps1
#
# Needs the PC on and Gadgetvilla logged in at that time (the browser is headed), and a valid BigSeller
# session (npm run keep-alive keeps it alive). If the session has expired the run logs it and stops -
# there is no automated re-login, by policy.
#
# Keep this file ASCII only (same rule as the .bat wrappers): a Thai character in a -Description string
# here made Windows PowerShell 5.1 misparse every later double-quoted line in the file with a confusing
# "missing the terminator" error that pointed at a totally unrelated, already-correct line (confirmed
# live 2026-11-19) - the file is UTF-8 without a BOM and -File reads it under the system codepage.

$scriptsDir = $PSScriptRoot
$batPath = Join-Path $scriptsDir "run-transfer-status-check.bat"
$taskName = "BigSeller-Check-TransferStatus"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Once -At "08:00" `
  -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Hours 12)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs run-transfer-status-check.bat every 2 hours, 08:00-20:00 - checks opted-in transfer documents (DB_TRANSFER_TRACKING) for status changes or stuck documents and reports to LINE. Log: logs\scheduled-transfer-status-check.log" `
  -Force | Out-Null

Write-Host "Installed: $taskName (every 2h, 08:00-20:00)"
Get-ScheduledTask -TaskName $taskName | Format-Table TaskName, State

Write-Host ""
Write-Host "To remove later:"
Write-Host ('  Unregister-ScheduledTask -TaskName ''{0}'' -Confirm:$false' -f $taskName)
