# Task: Implement BigSeller-WaveEngine (Phase 1 — Dry-run + Tier 1)

**Reference spec:** `FEATURE-auto-confirm-and-wave-priority-engine.md` (read this first — it is the source of truth for all business rules, tiers, and locator strategy)
**Repo:** BigSeller-Inventory (new module `wave-engine/` alongside existing Playwright code)
**Reuse:** existing browser session/fingerprint fix and locale (`th-TH`) fix — do not spin up a fresh browser context for this bot.

## Do this, in order

1. **Scaffold `wave-engine/` module** inside the existing repo, sharing the current Playwright browser-context setup (don't duplicate login/session logic).

2. **Build the order-scanner function** that reads, per row on `status=new`:
   - `logistics_channel`
   - `urgent_flag` (บาร์ด่วนพิเศษ presence)
   - `delivery_date` (กำหนดส่ง field, Seller Delivery rows only)
   - `warehouse` code
   Use the locator strategy from spec section 6 (testid > role-with-regex > text, in that order).

3. **Implement dry-run mode first — no live clicks.**
   For every order scanned, log: which Tier it matched, what action the bot *would* take (confirm / wait / flag-for-manual), and why. Write this to a log file or console, nothing else this phase.

4. **Implement only the Tier 1 decision rule live** (`Shopee-TH-Instant Delivery` → confirm immediately, no batching) behind a feature flag `ENABLE_LIVE_TIER1 = false` by default. All other tiers (0, 2, 2.5, 3, 4, 5) stay dry-run-only in this phase — do not implement their live actions yet.

5. **Implement the two-loop scheduler** from spec section 5a:
   - Urgent loop (2–3 min, lightweight filter+count only)
   - Main loop (10–15 min, full scan)
   Add the random jitter (±20–30s) and the mutex/lock so loops can't overlap. Fixed-time triggers (15:45 Tier 2.5 check, end-of-day sweep) can be stubbed as no-ops for now since only Tier 1 is live.

6. **Implement `create_wave()` exactly as specced**: set exactly one logistics channel's checkbox (never more than one, even for Tier 1 alone right now — but write the assertion so it holds once later tiers get enabled) → click "สร้าง" to open preview popup → set "ไม่ข้ามพื้นที่คลังสินค้า" (hard-coded, never toggle) → select all generated rows → click confirming "สร้าง" → log channel/zone/SKU/parcel counts per row.

7. **Guardrails to implement now, not later:**
   - Never auto-confirm a Seller Delivery order with `delivery_date = None` — flag it, don't guess.
   - Re-check order is still `status=new` immediately before confirming (idempotency).
   - Unclassified `logistics_channel` → flag for manual review, never auto-confirm.
   - **`create_wave()` must assert exactly one channel checkbox is checked before clicking "สร้าง" — throw loudly if more than one is checked.** This guards against ever combining carriers into one Wave (e.g. `Lazada-LEX` must never share a Wave with anything else), and is cheap to add now even though only Tier 1 is live.

## Do NOT do yet (later phases)

- Do not enable live actions for Tier 0, 2, 2.5, 3, 4, 5 — dry-run log only.
- Do not build the 15:45 forced-trigger or end-of-day sweep logic beyond a stub.
- Do not remove or bypass the existing session/fingerprint/locale fixes to "simplify" this bot.

## Definition of done for this phase

- Bot runs unattended for a full business day in dry-run mode with zero crashes.
- Dry-run log for Tier 1 orders matches what a human operator would have done (spot-check manually).
- Tier 1 live mode, once flipped on, confirms + creates a correctly-scoped, zone-split Wave with no manual intervention.
- Every guardrail in step 7 has a corresponding log line proving it fired when triggered (test by seeding a Seller Delivery order with no delivery date, and an order from an unmapped courier).

Once this phase is verified in production for a few days, next task will cover enabling Tier 0, then Tier 2/2.5/3/4, then Tier 5 — one at a time, per the phased rollout already agreed.
