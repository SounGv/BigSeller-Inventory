# Run this file in an ELEVATED PowerShell (same requirement as
# install-keep-alive-task.ps1 — Claude Code's sandbox has no permission to
# register scheduled tasks itself):
#   powershell -ExecutionPolicy Bypass -File .\install-scheduled-syncs.ps1
# from this scripts\ folder, in a window opened via "Run as Administrator".
#
# Registers Task Scheduler entries, each running every 30 minutes
# indefinitely, for the syncs built 2026-09-01/02 (see
# FEATURE-dashboard-home-page.md 1b/1c/1d, FEATURE-operator-picking-performance.md,
# FEATURE-sales-online-offline-report.md). Confirmed with the user before
# installing this — this project has a history of being deliberately
# cautious about turning on new automated BigSeller scraping.
#
# Requires npm-run-keep-alive's session (or a fresh npm run login:bigseller)
# already valid — these will just log "session expired, needs manual
# re-login" into their own log file if the session lapses, same as every
# other script in this project (no automated re-login, by policy).

$scriptsDir = $PSScriptRoot

$tasks = @(
  @{ Name = "BigSeller-Sync-TransferInTransit"; Bat = "run-transfer-in-transit.bat" },
  @{ Name = "BigSeller-Sync-CancelledAfterPack"; Bat = "run-cancelled-after-pack.bat" },
  @{ Name = "BigSeller-Sync-WarehouseBacklog"; Bat = "run-warehouse-backlog.bat" },
  @{ Name = "BigSeller-Sync-OperatorWaveRanking"; Bat = "run-operator-wave-ranking.bat" },
  @{ Name = "BigSeller-Sync-SalesSummary"; Bat = "run-sales-summary.bat" },
  @{ Name = "BigSeller-Reconcile-DecoyWarehouse"; Bat = "run-decoy-reconciliation.bat" },
  @{ Name = "BigSeller-Sync-OrderFunnel"; Bat = "run-order-funnel.bat" },
  @{ Name = "BigSeller-Sync-BestSellers"; Bat = "run-best-sellers.bat" },
  @{ Name = "BigSeller-Sync-WarehouseStockCount"; Bat = "run-warehouse-stock-count.bat" }
)

$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

foreach ($t in $tasks) {
  $batPath = Join-Path $scriptsDir $t.Bat
  $action = New-ScheduledTaskAction -Execute $batPath
  # Every 30 min, starting 2 min from now, repeating for up to a year (Task
  # Scheduler has no true "forever" repetition duration — MaxValue overflows
  # its XML serializer, 365 days is the practical ceiling and re-registering
  # yearly is not a real concern for this use case).
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 365)

  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings `
    -Description "Runs $($t.Bat) every 30 min — BigSeller-Inventory sync, see FEATURE-dashboard-home-page.md" `
    -Force | Out-Null

  Write-Host "Installed: $($t.Name)"
}

Write-Host ""
Write-Host "All $($tasks.Count) tasks installed. Starting them now so they're active immediately (not just at the next 30-min mark)..."
foreach ($t in $tasks) {
  Start-ScheduledTask -TaskName $t.Name
}

Write-Host ""
foreach ($t in $tasks) { Get-ScheduledTask -TaskName $t.Name | Format-Table TaskName, State }
Write-Host "Logs: BigSeller-Inventory\logs\scheduled-*.log"
Write-Host "To remove all later:"
Write-Host "  Get-ScheduledTask -TaskName 'BigSeller-Sync-*' | Unregister-ScheduledTask -Confirm:`$false"
Write-Host "  Get-ScheduledTask -TaskName 'BigSeller-Reconcile-*' | Unregister-ScheduledTask -Confirm:`$false"
