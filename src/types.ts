export interface InventoryRow {
  sku: string;
  warehouse: string;
  area: string;
  position: string;
  positionType: string;
  stockAtPosition: number;
  lockedStock: number;
  availableStock: number;
  unshelvedStock: number;
  maxStock: number;
  minStock: number;
  sourceUpdatedAt: string;
  sourceUrl: string;
}

export type ReplenishStatus = 'ต้องเติมทันที' | 'ยังเติมได้' | 'เต็มแล้ว';

export interface ReplenishResult {
  canReplenish: number;
  status: ReplenishStatus;
}

export interface SalesReportRow {
  sku: string;
  productName: string;
  quantitySold: number;
  salesAmount: number;
  reportPeriod: string;
  sourceUpdatedAt: string;
  sourceUrl: string;
}

export interface ReplenishTransaction {
  sku: string;
  warehouse: string;
  area: string;
  position: string;
  positionType: string;
  quantityAdded: number;
  employeeName: string;
  recordedAt: string;
}

export interface SyncLogEntry {
  timestamp: string;
  job: 'inventory' | 'sales' | 'bigseller-sync';
  status: 'success' | 'failure';
  rowsProcessed: number;
  durationMs: number;
  message?: string;
  runId?: string;
}

export interface ErrorLogEntry {
  timestamp: string;
  job: 'inventory' | 'sales' | 'login-check' | 'bigseller-sync' | 'validate-sync' | 'plan-moves' | 'export-moves' | 'validate-moves' | 'import-moves';
  url: string;
  step: string;
  errorMessage: string;
  screenshotPath?: string;
  runId?: string;
}

/** Composite dedupe key for inventory rows: sku + warehouse + area + position + positionType */
export function inventoryRowKey(row: Pick<InventoryRow, 'sku' | 'warehouse' | 'area' | 'position' | 'positionType'>): string {
  return [row.sku, row.warehouse, row.area, row.position, row.positionType].join('::');
}

/** SKU-level totals across an entire warehouse, from the "รายการสินค้าคงคลัง" export (distinct page from location-level inventory). */
export interface SkuInventoryRow {
  sku: string;
  warehouse: string;
  totalWarehouseStock: number;
  availableWarehouseStock: number;
  lockedWarehouseStock: number;
  unshelvedWarehouseStock: number;
  sourceUpdatedAt: string;
  sourceUrl: string;
}

/** Dedupe key for SKU-level totals: sku + warehouse */
export function skuInventoryRowKey(row: Pick<SkuInventoryRow, 'sku' | 'warehouse'>): string {
  return [row.sku, row.warehouse].join('::');
}

/** Result of one full Phase-1 sync run — every downstream phase must key off the same runId. */
export interface SyncRunResult {
  runId: string;
  syncStartedAt: string;
  syncCompletedAt: string;
  locationRows: InventoryRow[];
  skuRows: SkuInventoryRow[];
}

/** YYYYMMDDHHmmss + a random 4-char suffix, so two syncs in the same second still get distinct ids. */
export function generateRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${stamp}-${suffix}`;
}

export type TransferStatus = 'PLANNED' | 'EXPORTED' | 'IMPORTED' | 'FAILED' | 'CANCELLED';

/** One source→target line in a replenishment transfer plan. Multiple rows can share the same (runId, sku, targetPosition) when several source positions are needed to fill one target. */
export interface TransferPlanRow {
  runId: string;
  sku: string;
  sourcePosition: string;
  targetPosition: string;
  sourceQty: number;
  targetQty: number;
  targetZone: string;
  stockAtPosition: number;
  totalWarehouseStock: number;
  replenishableQty: number;
  moveQty: number;
  status: TransferStatus;
  createdAt: string;
}

/** A target position that qualified for replenishment but for which no usable source position could be found. */
export interface TransferExceptionRow {
  runId: string;
  sku: string;
  targetPosition: string;
  replenishableQty: number;
  warehouseRemainingQty: number;
  reason: string;
  recordedAt: string;
}

/** One row from the "รายงาน SKU Merchant" sales-analysis report — used to flag best-selling SKUs on a transfer document's remark, not related to `SalesReportRow` (a different, still-broken report page). */
export interface SkuSalesRow {
  sku: string;
  avgDailySales: number;
}

/** One SKU line from one order on `order/index.htm?status=new` — one order can produce several of these (multi-line-item orders). `store` decides which sheet this ends up in (see order-demand-service.ts): `store === 'LockStock'` → offline lock, anything else → pending online demand. `orderId` is BigSeller's own internal numeric id (the `<tr data-orderid="...">` attribute, confirmed live 2026-08-31) — used as the join key between the LockStock-filtered and unfiltered scrapes since it's guaranteed unique/stable, unlike the human-typed `orderNo`. */
export interface NewOrderLineRow {
  sku: string;
  qty: number;
  store: string;
  platform: string;
  orderId: string;
  orderNo: string;
  buyerOrLabel: string;
  orderTime: string;
  sourceUrl: string;
}

export type LockStatus = 'confirmed' | 'pending_confirm';

/** Dedupe key for DB_PENDING_ORDER_DEMAND / DB_OFFLINE_LOCK — these sheets reflect current-state-at-sync-time, not history, so the key intentionally does NOT include runId (see writeOrderDemand in order-demand-service.ts). */
export function newOrderLineKey(row: Pick<NewOrderLineRow, 'orderNo' | 'sku'>): string {
  return [row.orderNo, row.sku].join('::');
}

export type LineNotifyStatus = 'success' | 'failed';

/** One row per runId ever notified about — the dedupe record that stops import:moves from re-notifying the same run twice (e.g. on a retried/resumed import). */
export interface TransferNotificationLogRow {
  runId: string;
  timestamp: string;
  billCount: number;
  skuCount: number;
  moveRowCount: number;
  totalMoveQty: number;
  lineStatus: LineNotifyStatus;
  lineRequestId: string;
  errorMessage: string;
}
