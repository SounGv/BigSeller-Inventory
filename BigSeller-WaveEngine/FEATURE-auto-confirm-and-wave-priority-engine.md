# Project: BigSeller-WaveEngine

**Feature:** Auto Confirm Order + Auto Create Wave (Priority Engine)
**Built on / shares session with:** BigSeller-Inventory (Playwright)
**Related known issues to check against before implementing:** browser fingerprint mismatch session bug, `th-TH` locale redirect-modal bug (see existing fix notes) — both can break selectors/session on the order and WMS pages, so the poller in this feature must reuse whatever session/fingerprint fix is already in place, not a fresh browser context.

## 1. Objective

Replace manual "sit and click" order confirmation + Wave creation with a scheduled bot loop that:
1. Confirms orders on `bigseller.com/web/order/index.htm?status=new` in priority order.
2. Creates Waves on `bigseller.com/web/waveShip/wave/generatedWave.htm` grouped by warehouse zone, without a human deciding the order.

This spec formalizes the business rules already agreed with ops into a decision tree the bot executes directly.

## 2. Priority tiers (source of truth)

| Tier | Match condition (logistics group / flag) | Trigger to act | Action |
|---|---|---|---|
| 0 | `Seller Delivery` **and** delivery-date field (`กำหนดส่ง`) = today or unset-but-urgent-badge present | Immediately, every poll cycle | Confirm now |
| 1 | `Shopee-TH-Instant Delivery` (ส่งทันที 2 ชม.) | Immediately | Confirm + create Wave alone (no batching) |
| 2 | `TikTok-TH-J&T`, `Shopee-TH-SPX (รับที่จุดบริการ)`, `TikTok-TH-KEX`, `SPX Express(TH)` — **one Wave per carrier** | On rolling cutoff windows (config: morning/afternoon truck times) | Confirm + create Wave, per carrier, one at a time |
| 2.5 | `TikTok-TH-BEST Express`, `Shopee-TH-DHL Domestic` — **tracked and Waved separately, never combined** | Per carrier: `count >= 10` **OR** `now >= 16:00` (whichever first) | Confirm + create Wave, per carrier |
| 3 | `Shopee-TH-Express Delivery (SHP Food)`, `Shopee-TH-Express Delivery (SPX)` — **one Wave per carrier** | On standard express cutoff | Confirm + create Wave, per carrier, one at a time |
| 4 | Remaining `ALL Online` group: Flash Bulky, Best Bulky, SPX, Lazada-Flash, TikTok-J&T std, TikTok-Flash, **Lazada-LEX** — **one Wave per carrier, strictly no combining** | On standard cutoff rounds | Confirm + create Wave, per carrier, one at a time |
| 5 | `Seller Delivery` with delivery date = future / no urgent flag | End of day batch | Confirm + create Wave last |

**Hard rule (applies to every tier from 2 upward): never select more than one logistics channel/carrier at a time when creating a Wave**, even if they share the same tier and the same cutoff/trigger condition. Each carrier gets its own Wave-creation pass. This was called out explicitly for `Lazada-LEX`, which must never be combined with any other carrier under any circumstance — but the rule is general, not a `Lazada-LEX`-only exception.

Also-always-on override: any order flagged with the platform's own urgency indicator ("บาร์ด่วนพิเศษ") jumps to front of whatever tier it's in, regardless of the table above.

## 3. Data the bot must read per order row

From the order list page (`status=new`):
- `logistics_channel` — text from the ตัวกรอง "โลจิสติกส์" grouping (used to map to a Tier above)
- `urgent_flag` — presence of the SLA countdown/urgent bar indicator
- `delivery_date` — from "การตั้งค่าการจัดส่ง" column, specifically the "กำหนดส่ง" sub-field (only populated for Seller Delivery rows; blank = needs to be set or treated as unscheduled)
- `warehouse` — cluster/stock code (e.g. `STOCK_5`) from the คลังสินค้า filter, needed later for Wave zone-splitting

From the Wave-preview popup (`ดูตัวอย่าง`) on the WMS page:
- `พื้นที่คลังสินค้า` (zone, e.g. `FANTECH`, `3FL Ugreen`) per generated row
- `จำนวนพัสดุ` / `ประเภท SKU` / `จำนวนสินค้า` per row (for logging / batch-count checks)

## 4. Decision loop (pseudocode)

Note: this pseudocode shows the full decision tree in one block for readability, but per section 5a it actually runs as two separate loops (urgent loop for Tier 0/1, main loop for everything else) plus two fixed-time triggers — split accordingly when implementing.

```
loop every POLL_INTERVAL_MINUTES:
    orders = fetch_new_orders()

    # Tier 0 — walk-in / urgent-flagged Seller Delivery
    for o in orders where o.logistics == "Seller Delivery":
        if o.delivery_date is None:
            flag_for_manual_input(o)   # cannot safely auto-classify without this field
            continue
        if o.delivery_date == today() or o.has_urgent_flag:
            confirm(o)
            queue_for_immediate_wave(o)

    # Tier 1 — instant delivery, always immediate, never batched
    for o in orders where o.logistics == "Shopee-TH-Instant Delivery":
        confirm(o)
        create_wave(logistics="Shopee-TH-Instant Delivery", no_cross_zone=True)

    # Tier 2 — same-day cutoff group. ONE CARRIER AT A TIME, never combined.
    if now() in CUTOFF_WINDOWS["tier2"]:
        for channel in TIER2_CHANNELS:              # e.g. J&T, SPX-pickup, KEX, SPX(TH)
            channel_orders = orders where o.logistics == channel
            if channel_orders is not empty:
                confirm_all(channel_orders)
                create_wave(logistics=channel, no_cross_zone=True)

    # Tier 2.5 — BEST Express + DHL Domestic. Each carrier tracked AND Waved separately.
    for channel in ["TikTok-TH-BEST Express", "Shopee-TH-DHL Domestic"]:
        pending = count(orders where o.logistics == channel, status="unconfirmed")
        if pending >= TIER25_BATCH_MIN or now() >= TIER25_CUTOFF:
            confirm_all(orders where o.logistics == channel)
            create_wave(logistics=channel, no_cross_zone=True)

    # Tier 3 — standard express. ONE CARRIER AT A TIME.
    if now() in CUTOFF_WINDOWS["tier3"]:
        for channel in TIER3_CHANNELS:                # SHP Food, SPX
            channel_orders = orders where o.logistics == channel
            if channel_orders is not empty:
                confirm_all(channel_orders)
                create_wave(logistics=channel, no_cross_zone=True)

    # Tier 4 — ALL Online standard group. ONE CARRIER AT A TIME — Lazada-LEX especially must never combine.
    if now() in CUTOFF_WINDOWS["tier4"]:
        for channel in TIER4_CHANNELS:                # Flash Bulky, Best Bulky, SPX, Lazada-Flash, J&T std, Flash Thailand, Lazada-LEX
            channel_orders = orders where o.logistics == channel
            if channel_orders is not empty:
                confirm_all(channel_orders)
                create_wave(logistics=channel, no_cross_zone=True)

    # Tier 5 — Seller Delivery real shipments, end-of-day sweep
    if now() >= END_OF_DAY_SWEEP_TIME:
        tier5_orders = orders where o.logistics == "Seller Delivery" and o.delivery_date > today()
        confirm_all(tier5_orders)
        create_wave(logistics="Seller Delivery", no_cross_zone=True)
```

`create_wave(logistics, ...)` takes exactly **one** carrier/channel per call — never a list of multiple channels. This is enforced by the function signature, not just convention, so a future code change can't accidentally re-introduce batched multi-carrier Waves.

`create_wave(...)` always:
1. Sets the checkbox for the single given logistics channel only — all other channel checkboxes must be unchecked before clicking "สร้าง".
2. Clicks "สร้าง" to open the "ดูตัวอย่าง" popup.
3. Sets **"ข้ามพื้นที่หรือไม่" = "ไม่ข้ามพื้นที่คลังสินค้า"** (hard requirement, never toggle this off).
4. Selects every generated row (one row = one warehouse zone).
5. Clicks the confirming "สร้าง" button inside the popup.
6. Logs channel, zone, SKU count, parcel count per row for audit.

## 5. Config values to externalize (do not hardcode in the bot)

- `CUTOFF_WINDOWS` per tier (morning/afternoon truck times) — these vary by warehouse and may change seasonally. Keys: `tier2`, `tier3`, `tier4` (kept separate now that each tier iterates per-carrier).
- `TIER25_BATCH_MIN = 10`, `TIER25_CUTOFF = "16:00"` — applied **per carrier** (BEST Express and DHL Domestic each tracked independently).
- `END_OF_DAY_SWEEP_TIME`.
- Channel-to-tier mapping list (so a new courier added in BigSeller doesn't silently fall into "unclassified").
- `NEVER_COMBINE_CHANNELS` — in practice this is just "all of them" per the hard rule above, but keep an explicit list (starting with `Lazada-LEX`) so the rule is visible in config, not buried only in code logic.

### 5a. Scheduling — poll loop frequencies

Orders flow in continuously all day, so use **separate loops per urgency**, not one interval for everything — a single fast interval wastes load on tiers that don't need it, a single slow interval risks Tier 0/1 SLA.

| Loop | Frequency | Covers | Notes |
|---|---|---|---|
| Urgent loop | Every 2–3 min | Tier 0 (walk-in/urgent Seller Delivery), Tier 1 (Instant 2h) | Lightweight check only — filter these two groups, don't full-scan the whole order table |
| Main loop | Every 10–15 min | Tier 2, 2.5, 3, 4 | Full scan + batch/cutoff condition check, then confirm + create Wave |
| Forced trigger | Fixed time 15:45 | Tier 2.5 (BEST/DHL) | Safety check in case batch of 10 hasn't hit yet — must fire before the 16:00 cutoff regardless of loop timing |
| End-of-day sweep | Fixed time, once/day (e.g. 18:00) | Tier 5 (Seller Delivery real shipment) | No need to poll frequently, most flexible tier |

Additional scheduling guardrails:
- Add **random jitter of ±20–30 seconds** to every loop's trigger time instead of firing on the exact minute, to avoid an obviously bot-like fixed cadence.
- The urgent loop must stay a cheap filter+count operation so it can safely run every 2–3 min without hammering the page.
- Every loop needs a **mutex/lock flag** so a new cycle never starts while the previous one (especially the main loop, which does more DOM work) is still running.

## 6. Locator strategy (Playwright)

Prefer, in this order: `getByTestId()` > `getByRole()` (with regex name to survive TH/EN locale switching) > `getByText()` as last resort. This directly guards against the existing `th-TH` locale redirect-modal bug, since hardcoded single-language text/role names break the moment the modal language flips.

| Locator | Use for |
|---|---|
| `getByRole('checkbox', { name: /.../ })` | Logistics filter checkboxes, warehouse checkboxes, row checkboxes in the Wave preview popup |
| `getByRole('button', { name: /สร้าง\|Create/i })` | The "สร้าง" button — note it appears twice (outer page vs. inside popup), scope the locator to the correct container each time |
| `getByRole('button', { name: /ยืนยัน\|Confirm/i })` | Confirming an order on the order list page |
| `locator.filter({ hasText: ... })` | Finding order rows matching a specific logistics channel, or filtering to rows not yet confirmed |
| `locator.filter({ has: page.getByRole(...) })` | Narrowing to rows that still contain an unconfirmed-state checkbox/button |
| `expect(locator).toHaveCount(n)` | Checking the Tier 2.5 pending count against the batch threshold of 10 |
| `locator.evaluateAll()` | Bulk-extracting zone / SKU count / parcel count from every row of the Wave preview popup in one call, for audit logging |
| `getByTestId('...')` | Use wherever BigSeller exposes a `data-testid` — most resilient option, immune to locale and copy changes |

Avoid `locator.first()` / `.nth(i)` for anything action-triggering (confirm, create) — the docs themselves warn this breaks silently if the DOM order shifts. Use `filter()` to uniquely identify the target row instead.

## 7. Safety / guardrails

- **Dry-run mode first**: log every intended confirm/wave-create action for a few days without actually clicking, compare against what a human would have done, before enabling live clicks.
- **Never auto-confirm an order with `delivery_date = None` under Seller Delivery** — route to a manual queue/alert instead of guessing; a wrong guess here means either making a walk-in customer wait or wasting a Wave slot.
- **Idempotency**: before confirming, re-check the order is still in `status=new` (avoid double-confirm race if poll interval overlaps a manual action).
- **Rate limiting / human-like pacing**: add small randomized delays between clicks to avoid overwhelming the page or tripping any anti-automation detection, consistent with whatever approach the existing fingerprint-mismatch fix already established.
- **Alerting**: if Tier 2.5 orders are still pending at 15:45 and haven't hit the batch trigger, send a notification (not just silently wait for 16:00) so a human can sanity-check before the cutoff.
- **Unclassified channel**: if `logistics_channel` doesn't match any known Tier, do NOT confirm automatically — flag for manual review and alert (new courier added in BigSeller is the most likely cause).
- **One carrier per Wave, always**: never check more than one logistics checkbox before clicking "สร้าง", even within the same tier/cutoff batch. Add an assertion in `create_wave()` that throws if more than one channel checkbox is checked at call time — this must fail loud, not silently combine. `Lazada-LEX` is the carrier this was explicitly flagged for, but the assertion should apply universally.

## 8. Open questions for implementation

1. Where does `delivery_date` (กำหนดส่ง) live in the DOM/API response reliably — is it only visible in the row-expanded view, or in the base list payload?
2. Does BigSeller expose any of this via a documented API/webhook, or is full Playwright DOM automation required for both confirm and Wave-create steps?
3. Should Tier 0 confirmations also auto-print a pick slip, or does that stay a separate manual step?
4. Multi-warehouse handling: is `CUTOFF_WINDOWS` / batch threshold per warehouse (STOCK_5 vs others) or global?
