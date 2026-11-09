# Registers ONE Task Scheduler entry that refreshes the dashboard's stock-value page once a day.
# Same pattern as install-order-stock-check-task.ps1. If registering from a normal window fails with
# "Access is denied", run this in an ELEVATED PowerShell instead:
#   powershell -ExecutionPolicy Bypass -File .\install-stock-value-sync-task.ps1
#
# Runs once a day at 07:00, not hourly: the old hourly "BigSeller Inventory Sync" task was disabled after BigSeller
# kept rejecting the automated session, so this stays at the lowest frequency that keeps the page useful.
# Needs the PC on and Gadgetvilla logged in at that time (the browser is headed), and a valid BigSeller session
# (npm run keep-alive keeps it alive). If the session has expired the run logs it and stops - there is no automated
# re-login, by policy.

$scriptsDir = $PSScriptRoot
$batPath = Join-Path $scriptsDir "run-stock-value-sync.bat"
$taskName = "BigSeller-Sync-StockValue"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Daily -At "07:00"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs run-stock-value-sync.bat daily at 07:00 - refreshes the tabs behind the dashboard's stock-value page (STOCK_5, online-sync, 4 other warehouses, BigSeller totals). Log: logs\scheduled-stock-value-sync.log" `
  -Force | Out-Null

Write-Host "Installed: $taskName (daily at 07:00)"
Get-ScheduledTask -TaskName $taskName | Format-Table TaskName, State

Write-Host ""
Write-Host "To remove later:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
