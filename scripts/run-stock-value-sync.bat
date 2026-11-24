@echo off
rem Refreshes everything the dashboard stock-value page reads, in this order:
rem   1. sync:sku-inventory                 STOCK_5                  -> tab DB_SKU_INVENTORY
rem   2. sync:decoy-warehouse-inventory     online-sync warehouse    -> tab DB_SKU_INVENTORY_DECOY
rem   3. sync:other-warehouses-inventory    STOCK_1/12/14/6/4        -> tab DB_SKU_INVENTORY_OTHER
rem   4. sync:stock-value-reference         BigSeller own totals     -> tab DB_STOCK_VALUE_BIGSELLER (so the diff note matches 1-3)
rem   5. sync:purchase-order-pending        open POs, qty+est. value -> tab DB_PURCHASE_ORDER_PENDING (last: needs step 4's avg unit cost)
rem Stops at the first failure: a failed run is almost always an expired BigSeller session, and retrying
rem the remaining steps against a logged-out session only adds noise. Steps 2-5 are all-or-nothing on their own tab.
rem Exit code 0 only when all five succeeded (Task Scheduler shows the result). Keep this file ASCII only:
rem cmd misreads other characters in comments.
cd /d "%~dp0.."
if not exist logs mkdir logs
set "LOG=logs\scheduled-stock-value-sync.log"
echo [%date% %time%] ===== stock-value sync start (DRY_RUN=%DRY_RUN%) >> "%LOG%"

call :run sync:sku-inventory || goto :failed
call :run sync:decoy-warehouse-inventory || goto :failed
call :run sync:other-warehouses-inventory || goto :failed
call :run sync:stock-value-reference || goto :failed
call :run sync:purchase-order-pending || goto :failed

echo [%date% %time%] ===== stock-value sync done >> "%LOG%"
exit /b 0

:failed
echo [%date% %time%] ===== stock-value sync STOPPED, remaining steps skipped >> "%LOG%"
exit /b 1

:run
echo [%date% %time%] Starting %1 >> "%LOG%"
call npm run %1 >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] FAILED %1 >> "%LOG%"
  exit /b 1
)
echo [%date% %time%] Finished %1 >> "%LOG%"
exit /b 0
