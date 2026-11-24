import { test, expect } from '@playwright/test';
import { MOVING_STATE_LABELS, TERMINAL_MOVE_STATUSES } from '../src/bigseller/moving-goods-page.js';
import { classifyStatusUpdate } from '../src/services/transfer-status-check-service.js';

const HOUR_MS = 60 * 60 * 1000;

test.describe('MOVING_STATE_LABELS / TERMINAL_MOVE_STATUSES', () => {
  test('maps every confirmed movingState code to its Thai label (confirmed live 2026-11-19 — NOT the UI tab display order)', () => {
    expect(MOVING_STATE_LABELS[0]).toBe('รอนำเข้า');
    expect(MOVING_STATE_LABELS[1]).toBe('รอหยิบสินค้า');
    expect(MOVING_STATE_LABELS[2]).toBe('เสร็จเรียบร้อย');
    expect(MOVING_STATE_LABELS[3]).toBe('ยกเลิก');
    expect(MOVING_STATE_LABELS[4]).toBe('กำลังหยิบสินค้า');
    expect(MOVING_STATE_LABELS[5]).toBe('กำลังนำเข้าชั้นวาง');
  });

  test('only "เสร็จเรียบร้อย" and "ยกเลิก" are terminal', () => {
    expect(TERMINAL_MOVE_STATUSES.has('เสร็จเรียบร้อย')).toBe(true);
    expect(TERMINAL_MOVE_STATUSES.has('ยกเลิก')).toBe(true);
    expect(TERMINAL_MOVE_STATUSES.has('รอนำเข้า')).toBe(false);
    expect(TERMINAL_MOVE_STATUSES.has('กำลังหยิบสินค้า')).toBe(false);
    expect(TERMINAL_MOVE_STATUSES.has('กำลังนำเข้าชั้นวาง')).toBe(false);
  });
});

test.describe('classifyStatusUpdate', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  const recentCreatedAt = new Date(now.getTime() - 1 * HOUR_MS).toISOString();
  const oldCreatedAt = new Date(now.getTime() - 5 * HOUR_MS).toISOString();

  test('status just turned "เสร็จเรียบร้อย" this check -> completed', () => {
    expect(classifyStatusUpdate('กำลังนำเข้าชั้นวาง', 'เสร็จเรียบร้อย', recentCreatedAt, now, 4 * HOUR_MS)).toBe('completed');
  });

  test('status just turned "ยกเลิก" this check -> cancelled', () => {
    expect(classifyStatusUpdate('รอนำเข้า', 'ยกเลิก', recentCreatedAt, now, 4 * HOUR_MS)).toBe('cancelled');
  });

  test('still non-terminal and younger than the stuck threshold -> none', () => {
    expect(classifyStatusUpdate('รอนำเข้า', 'รอนำเข้า', recentCreatedAt, now, 4 * HOUR_MS)).toBe('none');
  });

  test('still non-terminal and older than the stuck threshold -> stuck', () => {
    expect(classifyStatusUpdate('รอนำเข้า', 'รอนำเข้า', oldCreatedAt, now, 4 * HOUR_MS)).toBe('stuck');
  });

  test('progressed between two non-terminal states but still past the stuck threshold -> still stuck (progress alone does not reset the clock)', () => {
    expect(classifyStatusUpdate('รอนำเข้า', 'กำลังหยิบสินค้า', oldCreatedAt, now, 4 * HOUR_MS)).toBe('stuck');
  });

  test('exactly at the stuck cutoff counts as stuck (>=, not >)', () => {
    const exactCutoff = new Date(now.getTime() - 4 * HOUR_MS).toISOString();
    expect(classifyStatusUpdate('รอนำเข้า', 'รอนำเข้า', exactCutoff, now, 4 * HOUR_MS)).toBe('stuck');
  });
});
