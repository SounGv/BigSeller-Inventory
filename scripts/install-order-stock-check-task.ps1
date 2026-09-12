# Run this file in an ELEVATED PowerShell (same requirement as
# install-scheduled-syncs.ps1/install-keep-alive-task.ps1 — Claude Code's
# sandbox has no permission to register scheduled tasks itself):
#   powershell -ExecutionPolicy Bypass -File .\install-order-stock-check-task.ps1
# from this scripts\ folder, in a window opened via "Run as Administrator".
#
# Registers ONE Task Scheduler entry that runs once every morning at 08:00 —
# NOT every 30 minutes like install-scheduled-syncs.ps1's tasks. Confirmed
# with the user (2026-09-09): the new-orders scrape (syncOrderDemand) was
# deliberately turned off from the main sync pipeline on 2026-09-01 and
# should stay off there — this task calls it directly, once a day, only for
# this morning stock-check (see scripts/sync-order-stock-check.ts).
#
# Requires npm run keep-alive's session (or a fresh npm run login:bigseller)
# already valid at 08:00 — like every other script here, it just logs
# "session expired, needs manual re-login" and exits non-zero if not (no
# automated re-login, by policy).

$scriptsDir = $PSScriptRoot
$batPath = Join-Path $scriptsDir "run-order-stock-check.bat"

$action = New-ScheduledTaskAction -Execute $batPath
$trigger = New-ScheduledTaskTrigger -Daily -At "08:00"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "BigSeller-Sync-OrderStockCheck" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs run-order-stock-check.bat once daily at 08:00 — refreshes DB_PENDING_ORDER_DEMAND then rebuilds EMPLOYEE_STOCK_CHECK_VIEW, see the 2026-09-09 addendum in FEATURE-pending-demand-and-offline-lock.md" `
  -Force | Out-Null

Write-Host "Installed: BigSeller-Sync-OrderStockCheck (daily at 08:00)"
Get-ScheduledTask -TaskName "BigSeller-Sync-OrderStockCheck" | Format-Table TaskName, State

Write-Host ""
Write-Host "To remove later:"
Write-Host "  Unregister-ScheduledTask -TaskName 'BigSeller-Sync-OrderStockCheck' -Confirm:`$false"
