import type { Locator, Page } from '@playwright/test';
import { dismissOrderPageOverlays } from './order-page-overlays.js';
import { dismissLanguageSwitchGuideIfPresent, clickThroughGuide } from './dismiss-language-guide.js';
import { humanDelay } from '../utils/human-delay.js';
import { logger } from '../utils/logger.js';

export const GENERATE_WAVE_URL =
  process.env.BIGSELLER_GENERATE_WAVE_URL ?? 'https://www.bigseller.com/web/waveShip/wave/generatedWave.htm';

/** One node of the โลจิสติกส์ tree. `group` is the parent node's title ('' for a top-level group). */
export interface LogisticsTreeNode {
  title: string;
  group: string;
  checked: boolean;
  isGroup: boolean;
}

/** The page's own live totals, read before creating anything. */
export interface WaveSummary {
  parcels: number;
  skuTypes: number;
  items: number;
}

/** One row of the "ดูตัวอย่าง" preview — one row is one warehouse zone (spec §3). Logged per wave for the audit trail (spec §4 step 6). */
export interface WavePreviewRow {
  zone: string;
  /** The row's "ประเภท Wave" — e.g. "รวมประเภทเดี่ยว ..." (single-SKU batch) or "สินค้าหลายชนิด/ชิ้น" (multi-SKU). Decides how many parcels are worth one trip. */
  waveType: string;
  /** The row's own "ข้ามพื้นที่หรือไม่" value — what actually decides whether pickers cross zones. */
  crossZone: string;
  parcelCount: string;
  skuTypeCount: string;
  itemCount: string;
  rawRowText: string;
}

export interface CreateWaveResult {
  created: boolean;
  rows: WavePreviewRow[];
  summary: WaveSummary | null;
  note: string;
}

/**
 * Page Object for WMS → การจัดการ Wave → สร้างเป็น Wave
 * (`waveShip/wave/generatedWave.htm`) — spec §4's `create_wave` sequence.
 *
 * Filter layout confirmed live 2026-09-10 (read-only DOM dump; nothing on this
 * page was clicked, because its primary button is labelled "สร้าง" and creating
 * a wave puts a real picking task in front of warehouse staff):
 *  - `คลังสินค้าจัดส่ง`: a `bs-new-select` MULTIPLE select (hascheckall), found
 *    already holding a single "STOCK_5" tag.
 *  - `แพลตฟอร์ม`: same `bs-new-select` multiple widget.
 *  - `ร้านค้า`: the same two-control trap documented in wave-manage-page.ts — a
 *    `bs-new-select_normal_select` type-picker showing the literal text
 *    "ร้านค้า", followed by the real value picker.
 *  - `ประเภทพัสดุ`: plain native checkboxes,
 *    `input[type=checkbox][name=filterSite]` with values 1/2/3 =
 *    สินค้าเดียว (1 ชิ้น) / สินค้าเดียว (หลายชิ้น) / สินค้าหลายชนิด/ชิ้น.
 *  - `เลือกเวลา`: a type-picker (เวลาสั่งซื้อ) plus ทั้งหมด/วันนี้/เมื่อวาน/
 *    3 วัน/7 วัน/30 วัน/วันที่กำหนดเอง buttons.
 *  - `โลจิสติกส์`: an **ant-tree with checkboxes** (`ul.ant-tree`,
 *    `li[role=treeitem]`, `span.ant-tree-checkbox`, `span.ant-tree-title`) —
 *    NOT the flat checkbox list an earlier version of this file assumed. Its
 *    real shape, and the reason `setLogisticsScope` takes group-aware input:
 *      โลจิสติกส์ทั้งหมด
 *      ├── OFFLINE ALL → Seller Delivery
 *      ├── ALL Online → Shopee-TH-Flash Express Bulky, Shopee-TH-SPX Express,
 *      │                Lazada-TH-Flash Express, TikTok-TH-J&T Express,
 *      │                TikTok-TH-Flash Express Thailand
 *      └── จัดส่งภายในวัน → TikTok-TH-J&T Express, TikTok-TH-KEX Express Thailand
 *    Note "TikTok-TH-J&T Express" appears under BOTH "ALL Online" and
 *    "จัดส่งภายในวัน", so a courier name alone does NOT identify a node — the
 *    group is what carries the shipping-speed meaning the tiers are about.
 *  - The tree lists only couriers that currently have waveable orders, so a
 *    tier's node is absent until confirmed orders for it exist.
 *  - Live totals sit above the button as "จำนวนพัสดุ N ประเภท SKU N
 *    จำนวนสินค้า N", and the button itself is `button.ant-btn-primary` with the
 *    text "สร้าง" (exactly one on the page).
 *
 * STILL UNVERIFIED, and unverifiable without creating a real wave: everything
 * from {@link openPreview} onward — the "ดูตัวอย่าง" popup, the
 * "ข้ามพื้นที่หรือไม่" control (no radio of any kind exists on the page before
 * the popup opens), row selection, and the confirming "สร้าง". The first real
 * run must be watched by a person and this file corrected from what they see.
 *
 * Two behaviours deliberately fail closed:
 *  - a scope whose live parcel count is 0 is never submitted;
 *  - if "ไม่ข้ามพื้นที่คลังสินค้า" cannot be positively verified, no wave is
 *    created. Spec §4 calls no-cross-zone a hard requirement, and a cross-zone
 *    wave sends pickers walking between zones — worse than no wave at all.
 */
export class BigSellerGenerateWavePage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto(GENERATE_WAVE_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    await dismissOrderPageOverlays(this.page);
    await this.page.keyboard.press('Escape').catch(() => undefined);
  }

  /** The `<td>` holding a filter row's controls, addressed by the row's own label cell. */
  private filterCell(label: string): Locator {
    return this.page.locator('tr', { has: this.page.locator('td', { hasText: label }) }).first().locator('td').nth(1);
  }

  /**
   * Sets `คลังสินค้าจัดส่ง` to exactly `name`, then verifies the widget shows
   * it. Only STOCK_5 holds sellable stock, so a wave built for another
   * warehouse would be a picking list for stock that isn't there.
   */
  async setShippingWarehouse(name: string): Promise<void> {
    const cell = this.filterCell('คลังสินค้าจัดส่ง');
    const shownTags = await cell.locator('.bs-new-select_multiple_tag .tag_txt').allInnerTexts();
    if (shownTags.length === 1 && shownTags[0].trim() === name) return;

    await dismissLanguageSwitchGuideIfPresent(this.page);
    await clickThroughGuide(this.page, cell.locator('.inp_box').first());
    await humanDelay(300, 600);
    // Same dual locator as moving-goods-page.ts / wave-manage-page.ts: this
    // widget family renders options with no role=option at all in some builds.
    await clickThroughGuide(
      this.page,
      this.page.locator(`[role="option"]:text-is("${name}"), .bs-new-select_select_option_title_text:text-is("${name}")`).first(),
    );
    await humanDelay(200, 400);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await humanDelay();

    const after = (await cell.locator('.bs-new-select_multiple_tag .tag_txt').allInnerTexts()).map((text) => text.trim());
    if (!(after.length === 1 && after[0] === name)) {
      throw new Error(`generate-wave: คลังสินค้าจัดส่ง should be exactly [${name}] but shows [${after.join(', ')}]`);
    }
    await logger.info(`generate-wave: shipping warehouse scoped to ${name}`);
  }

  /**
   * Ticks the ประเภทพัสดุ boxes — สินค้าเดียว (1 ชิ้น) / สินค้าเดียว (หลายชิ้น)
   * / สินค้าหลายชนิด, i.e. `input[name=filterSite]` values 1, 2 and 3
   * (confirmed live 2026-09-10).
   *
   * Unticked means "every type", confirmed live 2026-09-11 (the totals read
   * 524 parcels both before and after ticking all three). This is therefore
   * NOT what makes a scope non-empty — it is here to make the scope
   * deterministic: these boxes hold whatever a human last left them as, and a
   * leftover "สินค้าเดียว (1 ชิ้น)" would silently drop every multi-item order
   * from the wave, which are exactly the ones a picker most needs listed.
   */
  async selectAllPackageTypes(): Promise<void> {
    const cell = this.filterCell('ประเภทพัสดุ');
    const boxes = cell.locator('input[type="checkbox"][name="filterSite"]');
    const count = await boxes.count();
    if (count === 0) {
      throw new Error('generate-wave: no ประเภทพัสดุ checkboxes found — page markup differs from 2026-09-10');
    }
    for (let index = 0; index < count; index++) {
      const box = boxes.nth(index);
      if (!(await box.isChecked().catch(() => false))) {
        await box.check({ timeout: 5000 }).catch(() => undefined);
        await humanDelay(150, 350);
      }
    }
    await this.page.waitForTimeout(1500);
    await logger.info(`generate-wave: ticked ${count} ประเภทพัสดุ option(s)`);
  }

  private get logisticsTree(): Locator {
    return this.page.locator('ul.ant-tree').first();
  }

  /** Reads the whole โลจิสติกส์ tree with each node's group and checked state. */
  async readLogisticsTree(): Promise<LogisticsTreeNode[]> {
    return this.logisticsTree.locator('li[role="treeitem"]').evaluateAll((items) =>
      items.map((item) => {
        const titleText = (item.querySelector(':scope > .ant-tree-node-content-wrapper .ant-tree-title')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const parentItem = item.parentElement?.closest('li[role="treeitem"]') ?? null;
        const groupText = (parentItem?.querySelector(':scope > .ant-tree-node-content-wrapper .ant-tree-title')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const checkbox = item.querySelector(':scope > .ant-tree-checkbox');
        return {
          title: titleText,
          group: groupText,
          checked: checkbox?.className.includes('ant-tree-checkbox-checked') ?? false,
          isGroup: item.querySelector(':scope > ul') !== null,
        };
      }),
    );
  }

  /**
   * Leaves exactly the requested nodes checked in the โลจิสติกส์ tree
   * (spec §4 step 1), then verifies it.
   *
   * `wanted` entries are matched on title, optionally narrowed by group — a
   * bare title is REJECTED when it matches more than one node, because
   * "TikTok-TH-J&T Express" exists under both "ALL Online" (standard) and
   * "จัดส่งภายในวัน" (same-day) and picking the wrong one would put same-day
   * parcels on a standard round or vice versa.
   *
   * Verified rather than assumed for the same reason as the order page's
   * warehouse filter: a silently-widened scope is how tier 1 ends up batched
   * with slower channels, which spec §2 forbids outright.
   */
  async setLogisticsScope(wanted: { title: string; group?: string }[]): Promise<void> {
    const nodes = await this.readLogisticsTree();
    if (nodes.length === 0) {
      throw new Error('generate-wave: the โลจิสติกส์ tree is empty — no orders are currently waveable');
    }

    const targets = wanted.map((request) => {
      const matches = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => node.title === request.title && (request.group === undefined || node.group === request.group));
      if (matches.length === 0) {
        throw new Error(
          `generate-wave: no โลจิสติกส์ node "${request.title}"${request.group ? ` under group "${request.group}"` : ''}. ` +
            `Available: ${nodes.map((node) => `${node.group ? `${node.group}/` : ''}${node.title}`).join(', ')}`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `generate-wave: "${request.title}" is ambiguous — it exists under groups [${matches.map((m) => m.node.group).join(', ')}]. ` +
            'Pass the group explicitly; the group is what carries the shipping-speed meaning.',
        );
      }
      return matches[0];
    });

    const items = this.logisticsTree.locator('li[role="treeitem"]');
    const rootCheckbox = items.first().locator(':scope > .ant-tree-checkbox');
    const isChecked = (locator: Locator) =>
      locator.evaluate((el) => el.className.includes('ant-tree-checkbox-checked')).catch(() => false);

    // Clear to a known-empty tree first, then click only the targets.
    //
    // Toggling each mismatched node instead does NOT work, and failed live on
    // 2026-09-11 with "wanted [ส่งด่วน/...], tree reports [OFFLINE ALL/Seller
    // Delivery, ส่งด่วน/...]": this is an ant-tree, so a click CASCADES to the
    // node's children, which invalidates the rest of the snapshot the loop was
    // working from — unchecking a parent already unchecks its leaf, and the
    // loop's next click on that leaf turns it (and its parent) back on.
    // Clicking the checked root clears everything in one cascade.
    if (!(await isChecked(rootCheckbox))) {
      await clickThroughGuide(this.page, rootCheckbox); // check all...
      await humanDelay(200, 500);
    }
    await clickThroughGuide(this.page, rootCheckbox); // ...then clear all
    await humanDelay(300, 700);

    for (const target of targets) {
      await clickThroughGuide(this.page, items.nth(target.index).locator(':scope > .ant-tree-checkbox'));
      await humanDelay(200, 500);
    }
    await this.page.waitForTimeout(1200);

    const after = await this.readLogisticsTree();
    const path = (node: LogisticsTreeNode) => `${node.group ? `${node.group}/` : ''}${node.title}`;
    const checkedLeaves = after
      .filter((node) => node.checked && !node.isGroup)
      .map(path)
      .sort();
    // A group target is expanded to every leaf BENEATH it, following nested
    // groups all the way down — the root has sub-groups, so stopping at direct
    // children under-counts it badly (13 leaves reported as 2, live
    // 2026-09-11). Comparing only directly-named leaves would also skip
    // verification whenever a whole group is selected, which is exactly how
    // the top priorities are scoped.
    const descendantLeaves = (groupTitle: string): LogisticsTreeNode[] => {
      const groups = new Set([groupTitle]);
      for (let pass = 0; pass < after.length; pass++) {
        for (const node of after) {
          if (node.isGroup && groups.has(node.group)) groups.add(node.title);
        }
      }
      return after.filter((node) => !node.isGroup && groups.has(node.group));
    };
    const expectedLeaves = targets
      .flatMap(({ node }) => (node.isGroup ? descendantLeaves(node.title) : [node]))
      .map(path)
      .sort();
    const matches =
      checkedLeaves.length === expectedLeaves.length && checkedLeaves.every((leaf, index) => leaf === expectedLeaves[index]);
    if (!matches) {
      throw new Error(
        `generate-wave: logistics scope verification failed — wanted [${expectedLeaves.join(', ')}], tree reports [${checkedLeaves.join(', ')}]`,
      );
    }
    await logger.info(`generate-wave: logistics scope set to [${checkedLeaves.join(', ')}]`);
  }

  /**
   * The page's own "จำนวนพัสดุ N · ประเภท SKU N · จำนวนสินค้า N" totals — the
   * pre-flight check that there is anything to wave at all.
   *
   * Each total is a `<label>` holding TWO spans: the caption, then the number
   * in its own `.gen_num` (confirmed live 2026-09-11). An earlier version read
   * `text=จำนวนพัสดุ`, which resolves to the caption span alone — text
   * "จำนวนพัสดุ" with no digits in it — so every total parsed as 0. That is not
   * a harmless misread: `createWave` refuses to submit a 0-parcel scope, so the
   * bug silently aborted two real live runs that each had already confirmed an
   * order, while the page itself was showing 525 waveable parcels. Read the
   * `<label>` (both spans), never the caption.
   */
  async readSummary(): Promise<WaveSummary> {
    const totals = await this.page
      .locator('label')
      .filter({ has: this.page.locator('.gen_num') })
      .evaluateAll((labels) =>
        labels.map((el) => ({
          caption: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          value: Number((el.querySelector('.gen_num')?.textContent ?? '').replace(/[^\d]/g, '')),
        })),
      );
    const read = (caption: string) => totals.find((total) => total.caption.includes(caption))?.value ?? 0;
    return { parcels: read('จำนวนพัสดุ'), skuTypes: read('ประเภท SKU'), items: read('จำนวนสินค้า') };
  }

  /** The preview modal, identified by its own zone column header rather than a class, since this page's widget classes are generic. */
  private get previewModal(): Locator {
    return this.page
      .locator('.ant-modal-wrap:visible, .ant-modal:visible')
      .filter({ hasText: /พื้นที่คลังสินค้า|ดูตัวอย่าง/ })
      .first();
  }

  /** Clicks the outer "สร้าง" (confirmed live: exactly one `button.ant-btn-primary` with that text) to open the "ดูตัวอย่าง" preview — spec §4 step 2. */
  async openPreview(): Promise<boolean> {
    await dismissOrderPageOverlays(this.page);
    const createButton = this.page.getByRole('button', { name: /^(สร้าง|Create)$/i }).first();
    if ((await createButton.count()) === 0) {
      await logger.error('generate-wave: no "สร้าง" button found — page markup differs from what was confirmed on 2026-09-10');
      return false;
    }
    await humanDelay(500, 1200);
    await clickThroughGuide(this.page, createButton, { timeout: 5000 });
    return this.previewModal
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Checks that EVERY generated row is a no-cross-zone wave (spec §4 step 3's
   * hard requirement), and refuses the whole wave if any row is not.
   *
   * Corrected 2026-09-11 from a screenshot of the real popup: there is no
   * radio or toggle to set here, which is what an earlier version of this
   * method hunted for. "ข้ามพื้นที่หรือไม่" is a per-row COLUMN — each
   * generated row already reads "ไม่ข้ามพื้นที่คลังสินค้า" because the wave
   * rule decided it upstream — alongside a same-named dropdown at the top of
   * the popup that merely FILTERS the rows on show. Clicking that filter would
   * hide offending rows rather than fix them, which is worse than useless
   * here, so this only ever reads and reports.
   *
   * Verifying instead of setting is also the stronger guarantee: it fails on a
   * cross-zone row no matter how that row came to be.
   *
   * A zone is a FLOOR (told 2026-09-11: FANTECH is all on floor 5, Ugreen all
   * on floor 3 — "3FL Ugreen" says so outright), so a cross-zone wave is not
   * a longer walk, it is a picker carrying one order up and down between
   * floors. That is why the spec makes no-cross-zone a hard requirement and
   * why those rows are left for a person rather than quietly waved.
   */
  async verifyNoCrossZone(rows: WavePreviewRow[]): Promise<boolean> {
    if (rows.length === 0) return false;
    const offenders = rows.filter((row) => !row.crossZone.includes('ไม่ข้ามพื้นที่'));
    if (offenders.length > 0) {
      await logger.error(
        `generate-wave: ${offenders.length} of ${rows.length} preview row(s) are NOT "ไม่ข้ามพื้นที่คลังสินค้า" ` +
          `(${offenders.map((row) => `${row.zone}="${row.crossZone}"`).join(', ')}) — refusing to create a cross-zone wave`,
      );
      return false;
    }
    await logger.info(`generate-wave: all ${rows.length} preview row(s) confirmed no-cross-zone`);
    return true;
  }

  /**
   * Reads every preview row, resolving columns by their HEADER TEXT rather
   * than by position.
   *
   * The real popup (seen 2026-09-11) has eleven columns — หมายเลข,
   * อัปเดตคลังสินค้า, ประเภท Wave, วิธีการหยิบสินค้า, กลุ่มการจัดส่ง,
   * ข้ามพื้นที่หรือไม่, พื้นที่คลังสินค้า, จำนวนพัสดุ, ประเภท SKU, จำนวนสินค้า
   * — not the four an earlier guess here assumed, which put the zone at index
   * 1 (actually "หมายเลข", a row number) and would have written nonsense into
   * the audit log for every wave. Reading by header also survives BigSeller
   * adding or reordering a column.
   */
  async readPreviewRows(): Promise<WavePreviewRow[]> {
    // No named helper functions inside evaluate(): tsx/esbuild wraps those in
    // its `__name` helper, which does not exist in the page and throws
    // "__name is not defined" at runtime. Same trap already hit once in this
    // project's row collector — keep every function here anonymous and inline.
    // Scoped to the MODAL, not to one <table>: this is a vxe-table, which
    // renders its header and its body as two separate tables (same split as
    // the order list's list_header / list_items). Reading `table.first()`
    // picked up the header-only table and returned zero rows every time —
    // which then tripped the no-cross-zone check into refusing the wave.
    return this.previewModal.evaluate((modal) => {
      const headers = Array.from(modal.querySelectorAll('th')).map((th) =>
        (th.textContent ?? '').replace(/\s+/g, ' ').trim(),
      );
      const index = {
        zone: headers.findIndex((header) => header.includes('พื้นที่คลังสินค้า')),
        waveType: headers.findIndex((header) => header.includes('ประเภท Wave')),
        crossZone: headers.findIndex((header) => header.includes('ข้ามพื้นที่')),
        parcel: headers.findIndex((header) => header.includes('จำนวนพัสดุ')),
        sku: headers.findIndex((header) => header.includes('ประเภท SKU')),
        item: headers.findIndex((header) => header.includes('จำนวนสินค้า')),
      };

      return Array.from(modal.querySelectorAll('tbody tr'))
        .map((row) => {
          const cells = Array.from(row.querySelectorAll('td')).map((cell) =>
            (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
          );
          return {
            zone: index.zone >= 0 ? (cells[index.zone] ?? '') : '',
            waveType: index.waveType >= 0 ? (cells[index.waveType] ?? '') : '',
            crossZone: index.crossZone >= 0 ? (cells[index.crossZone] ?? '') : '',
            parcelCount: index.parcel >= 0 ? (cells[index.parcel] ?? '') : '',
            skuTypeCount: index.sku >= 0 ? (cells[index.sku] ?? '') : '',
            itemCount: index.item >= 0 ? (cells[index.item] ?? '') : '',
            rawRowText: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
          };
        })
        .filter((row) => row.rawRowText !== '');
    });
  }

  /**
   * Ticks exactly the given preview rows (by their index in
   * {@link readPreviewRows}) and verifies the count the table reports back.
   *
   * Row-by-row rather than the header's select-all, because not every row may
   * belong in the wave: BigSeller emits a cross-zone row whenever one order's
   * items sit in two zones (seen live 2026-09-11 — 17 clean rows plus one
   * "FANTECH,3FL Ugreen" row), and selecting all of them would create exactly
   * the cross-zone wave spec §4 forbids.
   *
   * This is a vxe-table, so the click target is the inner
   * `.vxe-checkbox--icon` — the outer wrapper is clickable but toggles
   * nothing, the same quirk already documented in wave-manage-page.ts.
   */
  async selectPreviewRows(indices: number[]): Promise<void> {
    if (indices.length === 0) throw new Error('generate-wave: asked to select zero preview rows');
    const rows = this.previewModal.locator('tbody tr');

    for (const index of indices) {
      await rows.nth(index).locator('.vxe-checkbox--icon').first().click({ timeout: 5000 });
      await humanDelay(150, 400);
    }
    await this.page.waitForTimeout(800);

    // vxe marks the CHECKBOX, not the row: the `<tr>` keeps its plain
    // `vxe-body--row` class while the cell's span gains `is--checked`
    // (confirmed live 2026-09-11 by dumping a row before and after a click).
    // Looking for a checked class on the row counted 0 every time and aborted
    // a selection that had in fact worked. Scoped to tbody so the header's own
    // select-all checkbox is not counted as a row.
    const selected = await this.previewModal
      .locator('tbody .vxe-cell--checkbox.is--checked')
      .count()
      .catch(() => -1);
    if (selected !== indices.length) {
      throw new Error(
        `generate-wave: row selection verification failed — ticked ${indices.length} row(s) but the table reports ${selected} selected. ` +
          'Refusing to create a wave whose contents are uncertain.',
      );
    }
    await logger.info(`generate-wave: selected ${selected} preview row(s)`);
  }

  /** Clicks the confirming "สร้าง" INSIDE the popup (spec §4 step 5) — scoped to the modal, since the same label exists on the page behind it. */
  private async confirmCreate(): Promise<boolean> {
    const button = this.previewModal.getByRole('button', { name: /^(สร้าง|ยืนยัน|Create|Confirm)$/i }).first();
    if ((await button.count()) === 0) {
      await logger.error('generate-wave: no confirming "สร้าง" button inside the preview popup');
      return false;
    }
    await humanDelay(500, 1200);
    await button.click({ timeout: 10000 });
    return this.previewModal
      .waitFor({ state: 'hidden', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * How many parcels are waiting for one carrier, without creating anything.
   *
   * Lets the caller apply the "full load now / short load after the batching
   * window" rule BEFORE committing to a wave, instead of finding out inside
   * createWave and having to abort.
   */
  async parcelsWaitingFor(carrier: { title: string; group?: string }, shippingWarehouse: string): Promise<number> {
    await this.setShippingWarehouse(shippingWarehouse);
    await this.selectAllPackageTypes();
    await this.setLogisticsScope([carrier]);
    return (await this.readSummary()).parcels;
  }

  /** Every carrier (leaf) sitting under `group`, so a caller can wave them one at a time. */
  async carriersInGroup(group: string): Promise<LogisticsTreeNode[]> {
    return (await this.readLogisticsTree()).filter((node) => !node.isGroup && node.group === group);
  }

  /**
   * The whole spec §4 `create_wave(...)` sequence for ONE carrier.
   *
   * Takes a single carrier, never a list — the spec's 2026-09-11 revision
   * makes "one carrier per wave, never combined" a hard rule (raised for
   * Lazada-LEX, applied to all), and asks for it to be enforced by the
   * signature so a later edit cannot quietly reintroduce a combined wave. A
   * caller covering several carriers calls this once per carrier.
   *
   * This CREATES A REAL WAVE — a real picking task for warehouse staff.
   * Callers must gate it on the priority's live flag; nothing here
   * second-guesses that.
   */
  async createWave(
    carrier: { title: string; group?: string },
    options: {
      shippingWarehouse?: string;
      minParcels?: number;
      /** Per-row threshold, so a single-SKU row and a multi-SKU row are judged differently. */
      minParcelsFor?: (row: WavePreviewRow) => number;
    } = {},
  ): Promise<CreateWaveResult> {
    if (options.shippingWarehouse) {
      await this.setShippingWarehouse(options.shippingWarehouse);
    }
    await this.selectAllPackageTypes();
    await this.setLogisticsScope([carrier]);

    // Spec hard rule (2026-09-11 revision): exactly ONE carrier per wave, so
    // a wave never mixes carriers — called out for Lazada-LEX, applied to all.
    // Asserted here, immediately before anything can be created, rather than
    // trusting the caller's scope: a group scope silently covering two
    // carriers is exactly the mistake this is meant to catch, and BigSeller's
    // own preview rows are labelled by GROUP ("ALL Online"), so a mixed wave
    // would not look wrong on screen.
    const checkedCarriers = (await this.readLogisticsTree()).filter((node) => node.checked && !node.isGroup);
    if (checkedCarriers.length !== 1) {
      throw new Error(
        `generate-wave: refusing to create a wave covering ${checkedCarriers.length} carriers ` +
          `[${checkedCarriers.map((node) => node.title).join(', ')}] — exactly one carrier per wave.`,
      );
    }

    const summary = await this.readSummary();
    await logger.info(`generate-wave: scope totals — parcels=${summary.parcels} skuTypes=${summary.skuTypes} items=${summary.items}`);
    if (summary.parcels === 0) {
      return { created: false, rows: [], summary, note: 'scope has 0 parcels — nothing to wave, "สร้าง" not clicked' };
    }

    // One wave is one walking round on ONE floor (FANTECH=5, Ugreen=3), so a
    // handful of parcels means sending someone up a floor for almost nothing.
    // Below the threshold it waits for the next cycle; the caller lifts the
    // threshold once the carrier's truck time arrives so nothing is stranded.
    const floor = options.minParcels ?? 1;
    if (summary.parcels < floor) {
      return {
        created: false,
        rows: [],
        summary,
        note: `only ${summary.parcels} parcel(s), below the ${floor}-parcel floor — waiting for more rather than sending a picker out for these`,
      };
    }

    if (!(await this.openPreview())) {
      return { created: false, rows: [], summary, note: 'preview popup did not open' };
    }

    const rows = await this.readPreviewRows();
    if (rows.length === 0) {
      await this.closePreview();
      return { created: false, rows, summary, note: 'preview listed no rows — nothing to create' };
    }

    // Rows too small for a trip are left behind as well, judged per wave type
    // (single-SKU rows need many more parcels than multi-SKU ones to be worth
    // the same round). Each row IS its own wave, so this is the level the
    // threshold belongs at — a carrier total would happily wave a 1-parcel row
    // just because another row was full.
    const tooSmall: WavePreviewRow[] = [];

    // Cross-zone rows are left behind rather than cancelling the whole wave.
    // Live 2026-09-11 a single 1-parcel cross-zone row sat among 17 clean ones
    // holding 415 parcels: refusing everything over that one row would strand
    // the lot. The skipped parcels are reported loudly instead, because
    // nothing else will ship them if no one notices.
    const compliant = rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.crossZone.includes('ไม่ข้าม'))
      .filter((entry) => {
        const floor = options.minParcelsFor?.(entry.row);
        if (floor === undefined || Number(entry.row.parcelCount) >= floor) return true;
        tooSmall.push(entry.row);
        return false;
      });
    const crossZone = rows.filter((row) => !row.crossZone.includes('ไม่ข้าม'));
    if (crossZone.length > 0) {
      await logger.warn(
        `generate-wave: SKIPPING ${crossZone.length} cross-zone row(s) — ` +
          `${crossZone.map((row) => `${row.zone} (${row.parcelCount} parcel(s))`).join(', ')}. ` +
          'These orders span two FLOORS (FANTECH=5, Ugreen=3) and need a human; the bot will not put them in a wave.',
      );
    }
    if (tooSmall.length > 0) {
      await logger.info(
        `generate-wave: holding ${tooSmall.length} row(s) that are too small for a trip — ` +
          tooSmall.map((row) => `${row.zone} ${row.parcelCount} parcel(s) [${row.waveType.slice(0, 30)}]`).join(', '),
      );
    }
    if (compliant.length === 0) {
      await this.closePreview();
      return {
        created: false,
        rows,
        summary,
        note:
          crossZone.length > 0 && tooSmall.length === 0
            ? 'every preview row is cross-zone — nothing safe to create'
            : 'no row is big enough for a trip yet — holding them all',
      };
    }

    await this.selectPreviewRows(compliant.map((entry) => entry.index));
    const created = await this.confirmCreate();
    const skippedNote = crossZone.length > 0 ? `, skipped ${crossZone.length} cross-zone row(s)` : '';
    return {
      created,
      rows,
      summary,
      note: created
        ? `created ${compliant.length} zone row(s)${skippedNote}`
        : `clicked สร้าง but the popup stayed open${skippedNote} — needs manual verification`,
    };
  }

  private async closePreview(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.previewModal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  }
}
