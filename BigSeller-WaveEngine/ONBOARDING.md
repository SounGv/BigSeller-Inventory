# BigSeller WaveEngine — team guide

Automates the two steps warehouse staff do by hand all day: **confirming new orders** on
`order/index.htm?status=new`, and **creating picking waves** on `waveShip/wave/generatedWave.htm`.

It drives the real BigSeller UI with Playwright. There is no API — everything here is
a real browser clicking real buttons, so the safety rules below are not optional.

---

## 1. The one thing to understand first

**Nothing clicks anything unless you explicitly say so.**

`WAVE_ENGINE_LIVE_PRIORITIES` is blank by default, and blank means a full dry run: the
engine scans, decides, and writes an audit line per order — and touches nothing. You turn
on one priority at a time, by number:

```bash
WAVE_ENGINE_LIVE_PRIORITIES=2 WAVE_ENGINE_MAX_LIVE_CONFIRMS=1 npm run wave-engine -- --once
```

Approving one channel says nothing about the others. That is deliberate: confirming a
Shopee Food order and confirming a bulk Lazada order are different decisions.

---

## 2. Setup

```bash
npm install
cp .env.example .env        # then fill it in — see notes inside the file
npm run login:bigseller     # opens a browser, you log in by hand, session is saved
```

Run `npm run keep-alive` in its own terminal whenever the engine runs. It owns the session
file and pings BigSeller every 8 minutes; without it the session expires mid-run. The
engine only reads that file, never writes it — two writers would corrupt it.

Never commit `.env`, `secrets/`, or `playwright/.auth/`. They are gitignored; keep it that way.

---

## 3. Daily commands

| Command | What it does | Touches anything? |
|---|---|---|
| `npm run wave-engine -- --board` | The queue right now, in priority order, plus each platform's truck time | No — 2 seconds, read only |
| `npm run wave-engine -- --wave-dry-run` | What is waveable per carrier, split into "ready" vs "left for a human" | No |
| `npm run wave-engine -- --dump` | Raw order rows next to what the parser made of them | No |
| `npm run wave-engine -- --zones` | Which FLOOR each channel's orders pick from, and which orders span both | No — ~4 min |
| `npm run wave-engine -- --once` | One full cycle: scan, decide, log | Only if live priorities are set |
| `npm run wave-engine -- --fast` | Same, but acts on the single highest-priority carrier — ~20s instead of ~2 min | Only if live priorities are set |
| `npm run wave-engine` | Daemon: urgent loop every ~3 min, main loop every ~12 min | Only if live priorities are set |

Start with `--board`. It answers "what do I confirm first" without reading a single row,
because BigSeller already counts the queue for you.

---

**One engine at a time.** Anything that can click takes a lock (`logs/wave-engine.lock`) and
refuses to start while another such run is alive. Two engines on one account scan the same
queue, reset each other's filters mid-read, and can confirm the same order twice. Read-only
modes (`--board`, `--zones`, `--wave-dry-run`, `--dump`) skip the lock — they are safe to run
while the engine works.

**Every cycle starts from a clean page.** BigSeller remembers filters across page loads, so
reloading the URL is not a fresh start: whatever the last run or the last person left selected
is still applied. Each cycle resets all four filter rows to ทั้งหมด and reads the selection
back to confirm it moved. Skipping this is what made a live run on 2026-09-12 read 69 orders
out of 508 and abandon itself.

---

## 4. The rules it follows

**Platforms.** The engine only ever acts on orders from **Shopee, Lazada and TikTok**. Manual
orders (`คำสั่งซื้อด้วยตนเอง`), WooCommerce, POS and chat orders belong to a different process
and are excluded before anything else is considered — this guard sits outside every other rule,
so a blocked order is skipped even when its tier, timing and stock all check out. The list is
`WAVE_ENGINE_ALLOWED_PLATFORMS`.

**Oldest first.** Within one priority, the order that came in first is acted on first. This is
what makes the 13:00 restart correct for ส่งทันที: the backlog that piled up before the 11:45
stop has already burned part of its 2-hour SLA, so it clears before anything newer. An order
whose timestamp cannot be read sorts to the back of its priority rather than being dropped.

**Bug fixed 2026-09-14 — this never actually worked before today.** The เวลา cell's real shape is
`"Paid 11 ก.ย. 2026 20:36 Expire 12 ก.ย. 2026 23:59 หมดอายุใน 16 ชั่วโมง"` — a placed time AND an
Expire deadline in one string. The parser used to hand that WHOLE string to a function that only
matches a single exact date-time token, so it failed on every real row: `orderTime` was always
`null`, and "oldest first" silently did nothing — orders sorted however the DOM scan happened to
list them. Fixed by splitting the placed time from the Expire deadline before parsing either one.

**Close to expiring jumps the queue.** BigSeller auto-cancels an order left unconfirmed past its
own Expire deadline — that loses the sale entirely, worse than any batching or truck-cutoff rule.
An order inside `WAVE_ENGINE_EXPIRY_URGENT_MINUTES` (default 120, a guess — not a number anyone
gave) of that deadline is confirmed now regardless of its tier's normal timing, sorted ahead of
everything else in its tier. This override sits BELOW the warehouse/reserved/platform guards —
those still win: a reservation about to expire is still never confirmed.

**Priority order** (1 = most urgent) lives in `src/wave-engine/channel-policy.ts`:

1. Express Delivery (SPX) — morning: wait for 10; from 13:00: any quantity
2. ส่งทันที 2 ชม. — runs until 11:45, pauses, resumes 13:00
3. SHP Food — same rule as 1
4. BEST Express + DHL Domestic — the only pair allowed to share a wave
5-12. LEX TH → SPX Express → TikTok J&T → TikTok Flash → Lazada Flash → SPX(TH) → KEX → Flash Bulky

Channels 4-12 wait for their platform's truck: **Shopee 16:01, Lazada 13:01, TikTok 14:01**,
read from the channel's own name prefix.

**Wave sizing.** One wave is one picking trip to one floor, so a wave is only created once
it is worth the trip: **50 parcels for single-SKU rows, 20 for multi-SKU rows**. Short loads
collect for 30 minutes and then go as one batch. A carrier that never reaches the threshold
is reported, not waved — someone decides by hand.

**Zones are floors.** FANTECH is floor 5, Ugreen is floor 3. An order whose items span both
produces a cross-zone row, and the engine refuses to put those in a wave: filling one means
a picker walking between floors. They are logged for a human every time.

---

## 5. What it will never do

- **Touch an order from outside Shopee / Lazada / TikTok.** The exclusion list is built from
  the platform filter's own counts and is read *exactly* — no tolerance. If a single row of it
  cannot be read, the cycle is abandoned, because an order missing from an exclusion list is an
  order that looks eligible.
- **Touch a `LockStock` order.** Those are stock reservations a salesperson is holding for a
  customer, not shipments. Excluded before any decision, again at classification, and once
  more immediately before the click. If that exclusion list cannot be read, the whole cycle
  is abandoned rather than guessed at.
- **Confirm an order outside `STOCK_5`.** That is the only warehouse holding sellable stock.
  Anything else needs a human to move goods first — the engine reports it and never moves
  stock itself.
- **Create a cross-floor wave**, or a wave covering more than one carrier.
- **Confirm the same order twice** in a cycle.
- **Log an unverified click as a success.** If it cannot prove the confirmation landed, it
  says so.

---

## 6. Where to look when something is odd

- `logs/wave-engine-YYYY-MM-DD.jsonl` — one line per order: priority, action, and the reason.
  Guardrail codes (`GUARD_…`, `EXCLUDED_…`, `BLOCKED_…`) are greppable.
- `logs/YYYY-MM-DD.log` — per-cycle summaries and every guardrail hit.
- `logs/wave-engine-state.json` — last wave time per carrier, which is what the 30-minute
  batching window measures from.

```bash
npm run test:unit     # 174 unit tests, no browser needed
npx tsc --noEmit
```

---

## 7. Known gaps (as of 2026-09-11)

- **Not yet verified live**: the 12-channel priorities, the per-type wave thresholds, the
  30-minute batching, the platform allowlist and the oldest-first ordering all pass unit tests
  but have not run a full day against the real site.
- **Orders touched before the platform guard existed (before 2026-09-11)** were never filtered
  by platform. On that day the `คำสั่งซื้อด้วยตนเอง` group held 79 orders, roughly 60 of them
  LockStock reservations already excluded — the other ~19 were inside the engine's reach. The
  hole is closed; the history has not been audited.
- **`เลือกเวลา` is not pinned.** The engine leaves BigSeller's time filter as it found it, so a
  wave can include older confirmed orders. Decide `วันนี้` vs `ทั้งหมด` and pin it.
- **Three couriers have no priority yet**: `SPX Express - ผู้ซื้อรับที่จุดบริการ`,
  `Lazada-TH-Flash TH Bulky`, `Shopee-TH-Best Express Bulky`. They fall to manual review, which
  is safe but means nobody is acting on them automatically.
- **BEST + DHL sharing a wave is not implemented** — they would be waved separately today.
- **Tier 0 (urgent walk-in Seller Delivery) cannot be automated from the list view**: the
  `กำหนดส่ง` date simply is not in it, so those orders always route to manual review.
