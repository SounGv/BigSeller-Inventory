const THAI_MONTHS: Record<string, number> = {
  'ม.ค.': 0, 'ก.พ.': 1, 'มี.ค.': 2, 'เม.ย.': 3, 'พ.ค.': 4, 'มิ.ย.': 5,
  'ก.ค.': 6, 'ส.ค.': 7, 'ก.ย.': 8, 'ต.ค.': 9, 'พ.ย.': 10, 'ธ.ค.': 11,
};

/**
 * Parses BigSeller's `"DD MMM YYYY HH:mm"` display strings (e.g.
 * `"01 ก.ย. 2026 15:52"`) into a Date. The year printed is already Gregorian
 * (confirmed live 2026-09-01 across every timestamp seen on the account,
 * e.g. "2026" not the Buddhist-era "2569") — no -543 adjustment needed.
 * Returns null on anything that doesn't match, rather than throwing —
 * callers decide whether an unparseable timestamp is fatal.
 */
export function parseThaiDateTime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})\s+(\S+)\s+(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, day, monthAbbr, year, hour, minute] = m;
  const month = THAI_MONTHS[monthAbbr];
  if (month === undefined) return null;
  return new Date(Number(year), month, Number(day), Number(hour), Number(minute));
}

const THAILAND_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Converts an epoch-millis field from a BigSeller API response (e.g.
 * `transfer/pageList.json`'s `createTime`) to a correct UTC ISO string.
 *
 * Confirmed live 2026-09-01 (transfer-page.ts): these epoch values are NOT
 * true UTC — `new Date(epochMs)` read back with UTC getters reproduces the
 * exact same clock digits as the API's own Thai-local display string (e.g.
 * `createTimeStr: "01 ก.ย. 2026 15:08"` and `new Date(createTime).toISOString()`
 * both read "15:08"). Proven wrong by cross-referencing against this
 * project's own log timestamps (true UTC, from `new Date().toISOString()`):
 * a transfer already fetched and logged at 08:50 UTC had a raw `createTime`
 * that naively decodes to 15:08 UTC — in the future relative to when it was
 * observed to already exist, which is impossible. The epoch is Thai
 * wall-clock time serialized as if it were UTC (an upstream bug on
 * BigSeller's side, not ours) — subtracting 7 hours recovers the true
 * instant. Do NOT apply this to epoch fields from other endpoints without
 * verifying the same way first — this is a confirmed quirk of this specific
 * field, not a general BigSeller behavior.
 */
export function thaiEpochToUtcIso(epochMs: number): string {
  return new Date(epochMs - THAILAND_UTC_OFFSET_MS).toISOString();
}

/** True if `date` falls on the same calendar day as `reference` (defaults to now), in local time. */
export function isSameLocalDay(date: Date, reference: Date = new Date()): boolean {
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}
