import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';

/**
 * Mirrors {@link SheetsClient}'s interface (`upsertRows`, `readRowsForRunId`,
 * `replaceAll`) so `order-demand-service.ts` / a future
 * `operator-performance-service.ts` can write to Supabase alongside Google
 * Sheets by adding one more client call, not new business logic — per
 * FEATURE-web-dashboard-supabase.md's dual-write transition plan.
 *
 * Uses the SERVICE ROLE key (never the anon key) — this runs server-side in
 * a Node script, not a browser, and needs to bypass the SELECT-only RLS
 * policy the frontend's anon key is deliberately restricted to. Never import
 * this file from the GV Ops Console frontend project.
 */
export class SupabaseDbClient {
  private constructor(private readonly client: SupabaseClient) {}

  static create(): SupabaseDbClient {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set in .env');
    }
    return new SupabaseDbClient(createClient(url, serviceRoleKey));
  }

  /** Upserts `rows` into `table`, matched on `keyColumns` — mirrors SheetsClient.upsertRows. Row keys must already be the table's real (snake_case) column names; callers are responsible for the camelCase-to-snake_case mapping, same as they already build header-keyed rows for SheetsClient. */
  async upsertRows(table: string, rows: Record<string, unknown>[], keyColumns: string[]): Promise<void> {
    if (rows.length === 0) return;
    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would upsert ${rows.length} row(s) into Supabase table "${table}"`);
      return;
    }
    const { error } = await this.client.from(table).upsert(rows, { onConflict: keyColumns.join(',') });
    if (error) throw new Error(`Supabase upsert into "${table}" failed: ${error.message}`);
    await logger.info(`Supabase: upserted ${rows.length} row(s) into "${table}"`);
  }

  /** Reads every row in `table` matching `run_id` — mirrors the runId-scoped read pattern in run-data.ts, for tables that DO stamp a run id (e.g. a future operator_performance write). Tables with no `run_id` column (pending_order_demand, offline_lock — see {@link replaceAll}) don't use this. */
  async readRowsForRunId(table: string, runId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client.from(table).select('*').eq('run_id', runId);
    if (error) throw new Error(`Supabase read from "${table}" (run_id=${runId}) failed: ${error.message}`);
    return data ?? [];
  }

  /** Selects `columns` from `table` where every key in `filters` equals its value — for the small, ad-hoc reads a sync service needs before deciding what to update (e.g. transfer-in-transit-service reading which transfers are still open before diffing against a fresh scrape). Not a general query builder — for anything beyond flat equality filters, use the Supabase dashboard/MCP directly. */
  async selectWhere(table: string, columns: string, filters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    let query = this.client.from(table).select<string, Record<string, unknown>>(columns);
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query;
    if (error) throw new Error(`Supabase select from "${table}" failed: ${error.message}`);
    return data ?? [];
  }

  /** Updates every row in `table` whose `column` value is in `values` with `patch`. No-ops if `values` is empty (an empty `.in()` filter would otherwise match nothing anyway, but this skips the round-trip and the DRY_RUN log noise). */
  async updateWhereIn(table: string, column: string, values: string[], patch: Record<string, unknown>): Promise<void> {
    if (values.length === 0) return;
    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would update ${values.length} row(s) in "${table}" where ${column} in (...)`);
      return;
    }
    const { error } = await this.client.from(table).update(patch).in(column, values);
    if (error) throw new Error(`Supabase update of "${table}" failed: ${error.message}`);
    await logger.info(`Supabase: updated ${values.length} row(s) in "${table}"`);
  }

  /**
   * Deletes every row in `table` and inserts `rows` fresh — mirrors
   * SheetsClient.replaceAll, for tables that reflect current-state-at-sync
   * rather than accumulated history (pending_order_demand, offline_lock: a
   * closed/confirmed order must disappear on the next sync). `.not('id',
   * 'is', null)` is Supabase-js's documented way to express "every row" —
   * `.delete()` alone is refused without a filter.
   */
  async replaceAll(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (DRY_RUN) {
      await logger.info(`[DRY_RUN] Would replace Supabase table "${table}" with ${rows.length} row(s)`);
      return;
    }
    const { error: deleteError } = await this.client.from(table).delete().not('id', 'is', null);
    if (deleteError) throw new Error(`Supabase clear of "${table}" failed: ${deleteError.message}`);

    if (rows.length > 0) {
      const { error: insertError } = await this.client.from(table).insert(rows);
      if (insertError) throw new Error(`Supabase insert into "${table}" failed: ${insertError.message}`);
    }
    await logger.info(`Supabase: replaced "${table}" with ${rows.length} row(s)`);
  }
}
