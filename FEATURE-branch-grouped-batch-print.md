# Feature request: branch-grouped batch printing for multi-branch B2B stores (e.g. COM 7)

**Target repo:** `BigSeller-Inventory` (Playwright automation)
**Related history:** builds on the existing session/fingerprint-mismatch and `th-TH` locale fixes already in this repo.

## Problem

Warehouse staff confirm new orders for the `COM 7` store (`ร้านค้า`), then do a picking "wave," then batch-print
labels/invoices for the confirmed orders. COM 7 is a single BigSeller store account, but it actually represents
**many physical retail branches** — each order carries a branch code as the numeric prefix of its order number
(`หมายเลขคำสั่งซื้อ`), e.g. order `2720-3559930-55` belongs to branch `2720`. This same branch code is also shown
as its own field next to the shipping method on each order row (label reads `Seller Delivery` / `2720`).

Today, BigSeller prints the batch in whatever order the on-screen table/selection is in. That order is **not**
grouped by branch, so labels come out interleaved across branches, which slows down the picking wave (pickers
have to shuffle back and forth between branch piles instead of finishing one branch's stack at a time).

## Confirmed constraint: BigSeller has no native sort/print-group by branch

I verified this directly in the live BigSeller order list (`https://www.bigseller.com/web/order/index.htm`) before
writing this spec, so the automation should not assume a native shortcut appears later without re-checking:

- The order-list sort dropdown (`เวลาอัปเดตคำสั่งซื้อ ⌄`) only exposes these keys (pulled straight from its
  `.ant-dropdown-menu` at runtime):
  `เวลาจ่าย, เวลาสั่งซื้อ, เวลาพิมพ์, มูลค่าคำสั่งซื้อ, โลจิสติกส์ที่ผู้ซื้อกำหนด, เวลาหมดอายุ, SKU ร้านค้า, SKU Merchant, จำนวนสินค้า, ประเภท SKU Merchant, ตำแหน่ง, เวลาอัปเดตคำสั่งซื้อ`
  — no "order number," "branch ID," or "recipient" key exists.
- **การตั้งค่า → ตั้งค่าการพิมพ์** only exposes a pick-order sort (`ลำดับการหยิบสินค้า → เรียงตามตำแหน่งชั้นวางสินค้า`)
  for the internal stock-transfer (`รายการโอนสินค้า`) and restock (`ใบเติมสต็อก`) documents — **not** for the
  customer-order documents (`Pick List`, `ใบปะหน้าพัสดุ`, `ใบแจ้งหนี้`, `ใบส่งของ`, `รายการสรุป`).

So there is no server-side setting to flip. The grouping has to happen by **filtering the order list down to one
branch at a time before each print action**, driven by automation.

## The lever that makes this possible: batch order-number search

The `หมายเลขคำสั่งซื้อ` filter field in the filter panel accepts **multiple order numbers at once**, separated by
comma or space (placeholder text: "การค้นหาแบบชุดต้องคั่นด้วยเครื่องหมายลูกน้ำหรือช่องว่าง"). There's also a
`แม่นยำ` (exact match) toggle next to it. This lets the automation isolate exactly the N orders belonging to one
branch, then select-all + batch-print just that subset.

## Proposed algorithm

```
1. Open the order list, apply the existing filters (ร้านค้า = COM 7, status = the tab currently used for
   confirming — รอยืนยัน/คำสั่งซื้อใหม่ by default, but make the status tab a parameter).
2. Fetch the full set of matching orders (not just the current page — see "Data source" below).
3. For each order, extract:
     - order_number (หมายเลขคำสั่งซื้อ), e.g. "2720-3559930-55"
     - branch_id = order_number.split('-')[0]   // e.g. "2720"
   (Sanity-check this against the separate "ID สาขา" field shown per row — same value, second source of truth.)
4. Group orders by branch_id. Sort the groups (config: by branch_id ascending, or by order count descending —
   ascending branch_id is probably more useful operationally so the same branch's pile is predictable across runs).
5. For each branch group, in sorted order:
     a. Clear/replace the หมายเลขคำสั่งซื้อ filter with this group's order numbers joined by commas.
     b. Toggle "แม่นยำ" on (exact match) and submit the filter.
     c. Click the header checkbox to select all rows in the now-filtered result set.
     d. Open "พิมพ์เป็นชุด" → click the target print action (make this a config value — likely
        "พิมพ์ใบปะหน้าพัสดุ" and/or "พิมพ์ใบแจ้งหนี้", confirm with the user which document(s) they actually
        hand to pickers).
     e. Wait for/capture the resulting print job (new tab or PDF); append to a per-run output list tagged with
        branch_id so branch order is preserved in the merged output.
     f. Clear the order-number filter before moving to the next branch group (don't let it stack).
6. Merge the captured print outputs in branch order into one PDF/print queue, OR just let each branch's print job
   fire as its own job in sequence — confirm with the user which they want (see "Open questions").
```

## Data source for step 2 — two options, pick one (or both, cross-checked)

- **Option A — DOM scrape with pagination.** Set page size to the max (`300 / Page`), and page through
  `1 - 50 of 50` / `1 / 1` style pagination controls until exhausted. Cheapest to build, but brittle to markup
  changes and to the live order counts shifting mid-scrape (new orders can land in the queue while the script is
  running — snapshot order numbers at the start of the run and don't re-query mid-flight).
- **Option B — use the built-in Excel export first.** The order list's `ส่งออก → ส่งออกคำสั่งซื้อทั้งหมด` dialog
  exports to Excel/CSV with a configurable field template (customer code, recipient name, phone, etc.). This is
  more robust for *getting the branch breakdown* (no pagination to fight, no DOM fragility), but the actual print
  action still has to happen through the live browser table (BigSeller doesn't expose a print-by-order-number-list
  API), so Option B only replaces the "how do I compute the groups" step, not the "how do I trigger print" step.
  Recommendation: use B to compute/verify groups, A (or the same DOM read) to drive the actual filter+select+print
  loop.

## Config parameters to expose

- `store_name` (default `"COM 7"`) — so this can be reused for any other multi-branch B2B account later, not just
  COM7. Worth checking which other names in the `ร้านค้า` filter list are also multi-branch corporate accounts
  before assuming COM7 is the only one.
- `status_tab` — which order-status view to run against (รอยืนยัน / กำลังยืนยัน / etc.)
- `print_action` — which entry in the `พิมพ์เป็นชุด` menu to invoke (พิมพ์ใบปะหน้าพัสดุ / พิมพ์ใบแจ้งหนี้ / พิมพ์ Pick List / ...)
- `branch_group_sort` — `"branch_id_asc"` (default) or `"count_desc"`

## Open questions for the user (confirm before building the print-trigger step)

1. Which exact print action(s) does "ปริ้นบิล" refer to — `พิมพ์ใบปะหน้าพัสดุ` (shipping label), `พิมพ์ใบแจ้งหนี้`
   (invoice), or both? The grouping logic is identical either way, just need the right menu item(s).
2. Should the script also **auto-click "ยืนยัน" (confirm)** as part of the run, or should it only operate on
   orders staff have already confirmed? (Recommend: only operate on already-confirmed orders — don't fold order
   confirmation into an unattended script, since that's an operational commitment, not just a print-formatting
   fix.)
3. Any other `ร้านค้า` besides COM 7 that should get the same branch-grouped treatment?
4. Acceptable run cadence — on demand (staff clicks a button before each pick wave) vs. scheduled?

## Reference: current per-branch order counts snapshot (COM 7, รอยืนยัน tab, taken during spec-writing — will already
be stale by the time this ships, included only to sanity-check the parsing logic against real data)

| branch_id | order count |
|---|---|
| 2720, 2567, 2387, 1098, 1085, 732, 730, 619, 609, 589, 366, 232, 175 | 3 each |
| 354, 293, 181, 163 | 2 each |
| 476, 459, 167 | 1 each |

(50 orders / 20 branches total at time of writing.)
