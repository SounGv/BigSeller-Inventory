import type { Page } from '@playwright/test';
import { dismissLanguageSwitchGuideIfPresent, clickThroughGuide } from './dismiss-language-guide.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/human-delay.js';

const MOVING_GOODS_URL = process.env.BIGSELLER_MOVING_GOODS_URL ?? 'https://www.bigseller.com/web/inventory/movingGoods/index.htm';

export interface ImportZoneResult {
  ok: boolean;
  message: string;
}

/**
 * Page Object for BigSeller's "ย้ายสินค้า" (moving goods) page — where a zone
 * import file becomes a real, live transfer document.
 *
 * Every selector below was confirmed live (2026-08-25) by opening the real
 * "นำเข้า" modal and inspecting its DOM directly:
 *  - The file input is a genuine `<input type="file" accept=".xls,.xlsx">`
 *    (the visible "อัปโหลดไฟล์" button just proxies a click to it), so
 *    Playwright's `setInputFiles()` can target it directly — no native file
 *    picker involved.
 *  - The modal's own submit button (`.ant-modal-footer button.ant-btn-primary`,
 *    text "นำเข้า") starts DISABLED and only enables once a file is attached.
 *  - There is NO row-level preview before submit. Clicking that button is the
 *    real, immediate action that creates the transfer document — first
 *    confirmed by attaching a throwaway file with a nonexistent SKU and
 *    clicking "ยกเลิก" (cancel) instead of submitting, to avoid creating a
 *    stray document while exploring this page.
 *  - The page's own limit is 5,000 rows per uploaded file.
 *
 * Confirmed live (2026-08-25) with a real supervised 2-row `AUTO_IMPORT=true`
 * submit: the modal closing IS the real success signal — a document (e.g.
 * "REUJR3200699") appeared immediately in the "รอนำเข้า" list with the exact
 * SKU/position/quantity data submitted. `waitForImportResult()` below reflects
 * this confirmed behavior, not a guess.
 */
export class BigSellerMovingGoodsPage {
  constructor(private readonly page: Page) {}

  private get movingGoodsNavLink() {
    return this.page.locator('span.module_title', { hasText: 'ย้ายสินค้า' });
  }

  private get warehouseFilterCombobox() {
    return this.page.getByRole('combobox').first();
  }

  private get importButton() {
    // Scoped to the toolbar, not the (not-yet-open) modal's own "นำเข้า" submit button.
    return this.page.getByRole('button', { name: 'นำเข้า', exact: true }).first();
  }

  private get modal() {
    return this.page.getByRole('dialog', { name: 'นำเข้าเพื่อสร้างใบย้ายสินค้า' });
  }

  private get fileInput() {
    return this.modal.locator('input[type="file"]');
  }

  private get modalSubmitButton() {
    return this.modal.getByRole('button', { name: 'นำเข้า', exact: true });
  }

  private get modalCancelButton() {
    return this.modal.getByRole('button', { name: 'ยกเลิก', exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(MOVING_GOODS_URL, { waitUntil: 'domcontentloaded' });
    await humanDelay();
    await this.ensureView();
  }

  async ensureView(): Promise<void> {
    await clickThroughGuide(this.page, this.movingGoodsNavLink);
    await humanDelay();
  }

  async selectWarehouse(name: string): Promise<void> {
    await dismissLanguageSwitchGuideIfPresent(this.page);
    const current = await this.warehouseFilterCombobox.textContent();
    if (current?.trim() === name) return;
    await clickThroughGuide(this.page, this.warehouseFilterCombobox);
    await humanDelay(200, 500);
    await clickThroughGuide(this.page, this.page.getByRole('option', { name, exact: true }));
    await humanDelay();
  }

  /**
   * Attaches `filePath` and clicks the real "นำเข้า" submit button — this
   * CREATES a real transfer document in BigSeller. Never call this from a
   * DRY_RUN / preview path.
   */
  async importZoneFile(filePath: string): Promise<ImportZoneResult> {
    await dismissLanguageSwitchGuideIfPresent(this.page);
    await this.importButton.click();
    await this.modal.waitFor({ state: 'visible' });
    await humanDelay(500, 900);

    await this.fileInput.setInputFiles(filePath);
    await this.modalSubmitButton.waitFor({ state: 'visible' });
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('.ant-modal-footer button.ant-btn-primary') as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      },
      { timeout: 20_000 },
    );
    await humanDelay(500, 900);

    await this.modalSubmitButton.click();
    const result = await this.waitForImportResult();
    await this.closeResultDialogIfPresent();
    await logger.info(`importZoneFile(${filePath}): ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Confirmed live (2026-08-25) during a real batch run: after the import
   * modal closes, BigSeller can pop up a SEPARATE generic "ผลลัพธ์" (result)
   * summary dialog (the same reusable dialog component used for other bulk
   * actions like batch-delete — "สำเร็จแล้ว: N ล้มเหลว: N ... ปิด") that does
   * NOT close itself. Left open, it sat on top of the page and blocked the
   * next file's "นำเข้า" toolbar click, which is what most of a batch run's
   * per-file failures turned out to be. Close it explicitly every time,
   * whether or not it actually appeared.
   */
  private async closeResultDialogIfPresent(): Promise<void> {
    const closeButton = this.page.getByRole('button', { name: /^(ปิด|Close)$/ });
    if (await closeButton.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeButton.first().click();
      await humanDelay(200, 500);
    }
  }

  /** Confirmed live (2026-08-25, see class doc comment) — modal closing = success, an error message staying visible inside it = failure. */
  private async waitForImportResult(): Promise<ImportZoneResult> {
    const modalClosed = this.modal.waitFor({ state: 'hidden', timeout: 30_000 }).then(() => true).catch(() => false);
    const errorVisible = this.modal
      .locator('.ant-form-item-explain-error, .ant-message-error')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    const closed = await Promise.race([modalClosed, errorVisible.then(() => false)]);
    if (closed) {
      return { ok: true, message: 'Modal closed after submit — transfer document created.' };
    }
    const errorText = await this.modal.locator('.ant-form-item-explain-error, .ant-message-error').first().textContent().catch(() => null);
    return { ok: false, message: errorText?.trim() || 'Modal stayed open after submit with no readable error text.' };
  }

  async cancelModal(): Promise<void> {
    await this.modalCancelButton.click();
  }

  private get firstDocumentRow() {
    return this.page.locator('table tbody tr').first();
  }

  /**
   * Reads the just-created document's number off the TOP row of the list —
   * relies on the list's default sort (newest-first by "เวลาสร้าง", confirmed
   * live 2026-08-25 across every real document created this session) staying
   * in effect. Call this immediately after a successful `importZoneFile()`,
   * before any other navigation reorders or refreshes the list.
   */
  async getMostRecentDocumentNumber(): Promise<string | null> {
    const link = this.firstDocumentRow.getByRole('link').first();
    if (!(await link.isVisible({ timeout: 3000 }).catch(() => false))) return null;
    return (await link.textContent())?.trim() ?? null;
  }

  /**
   * Polls until the top-of-list document number is one `seen` does not
   * already contain, returning it (without adding it — the caller owns
   * `seen` and decides when to record it).
   *
   * Confirmed live (2026-08-25) this needs to check against every document
   * seen so far in the run, not just the immediately-previous one: an
   * earlier version only compared against the previous document, which
   * missed cases where the list's newest-first sort was unstable between two
   * recently-created documents (likely a "เวลาสร้าง" timestamp collision —
   * several documents in a fast batch can share the same second) and
   * flickered to a stale-but-different value that still wasn't the real new
   * document. That caused a document to have its remark silently overwritten
   * with a later document's remark, while the real new document got none.
   *
   * Timeout widened 15s -> 25s, poll delay 300-600ms -> 500-900ms (2026-08-25)
   * per user report: on a slow/laggy connection the automation was moving to
   * the next step faster than BigSeller's own backend finished saving/
   * indexing a just-created document, timing this out (confirmed live: 3
   * timeouts logged in one real run). A slower, more patient poll costs
   * little on a fast connection but is what makes this survive a bad one.
   */
  async waitForUnseenDocument(seen: ReadonlySet<string>, timeoutMs = 25_000): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = await this.getMostRecentDocumentNumber();
      if (current && !seen.has(current)) return current;
      await humanDelay(500, 900);
    }
    return null;
  }

  /**
   * Opens the edit page for the document currently at the top of the list (in
   * a separate tab — confirmed live 2026-08-25) and sets its "หมายเหตุ" field.
   *
   * Confirmed live (2026-08-25) that the ORIGINAL approach here — reading the
   * "แก้ไข" link's `href` and `page.goto()`-ing a new tab to it — always
   * failed with `net::ERR_ABORTED at javascript:`. The link's `href` is a
   * bare `javascript:` placeholder; the real navigation happens via a
   * `window.open()` inside its click handler, not the href itself. Fixed to
   * capture whichever page the click actually opens instead of trying to
   * read a URL out of the link.
   */
  async setRemarkOnMostRecentDocument(remark: string): Promise<void> {
    const editLink = this.firstDocumentRow.getByRole('link', { name: 'แก้ไข', exact: true });
    if (!(await editLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      await logger.error('setRemarkOnMostRecentDocument: could not find an edit link on the most recent document row.');
      return;
    }

    // See dismiss-language-guide.ts — this guide reappears here too, not just
    // on the sales-report page, so both clicks in this flow go through
    // clickThroughGuide rather than a bare .click().
    const [editPage] = await Promise.all([
      this.page.context().waitForEvent('page', { timeout: 15_000 }),
      clickThroughGuide(this.page, editLink),
    ]);

    try {
      await editPage.waitForLoadState('domcontentloaded');
      await humanDelay();
      // The guide can render on this NEW TAB too, independently of the
      // original page — dismiss it here before the very first interaction
      // (fill), not just before the later "บันทึก" click.
      await dismissLanguageSwitchGuideIfPresent(editPage);

      // Confirmed live (2026-08-25) via network capture: BigSeller's save
      // request is `POST .../api/v1/inventory/movingPlan/edit.json` with the
      // notes field carrying this remark text, response `{"code":0,...}` on
      // success — and the value does persist (checked by re-loading the edit
      // page afterward and reading this exact textarea). This page also has
      // an UNRELATED third-party chat-widget textarea — `getByLabel`/the
      // preceding-text filter below correctly target BigSeller's own field
      // and not that one, but a plain blind `textarea.first()` can land on
      // the wrong one depending on DOM insertion order; do not simplify this
      // to that.
      const remarkField = editPage.getByLabel('หมายเหตุ').or(
        editPage.locator('textarea').filter({ has: editPage.locator('xpath=preceding::*[contains(text(),"หมายเหตุ")]') }),
      ).first();
      try {
        await remarkField.fill(remark, { timeout: 10_000 });
      } catch {
        await dismissLanguageSwitchGuideIfPresent(editPage);
        await remarkField.fill(remark);
      }
      await humanDelay(200, 500);
      await clickThroughGuide(editPage, editPage.getByRole('button', { name: 'บันทึก', exact: true }));
      await humanDelay();
      await logger.info(`setRemarkOnMostRecentDocument(${editPage.url()}): remark set and confirmed to persist.`);
    } finally {
      await editPage.close().catch(() => undefined); // BigSeller's own save handler already closes this popup tab on success
    }
  }
}
