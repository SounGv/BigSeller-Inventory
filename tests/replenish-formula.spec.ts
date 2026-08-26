import { test, expect } from '@playwright/test';
import { calculateReplenishment } from '../src/services/replenish-service.js';

test.describe('calculateReplenishment', () => {
  test('เติมได้อีก = MAX(0, max - current)', () => {
    expect(calculateReplenishment(55, 10, 100).canReplenish).toBe(45);
  });

  test('never returns a negative canReplenish when current exceeds max', () => {
    expect(calculateReplenishment(120, 10, 100).canReplenish).toBe(0);
  });

  test('status = ต้องเติมทันที when below minStock', () => {
    const result = calculateReplenishment(5, 10, 100);
    expect(result.status).toBe('ต้องเติมทันที');
  });

  test('status = ยังเติมได้ when between min and max', () => {
    const result = calculateReplenishment(55, 10, 100);
    expect(result.status).toBe('ยังเติมได้');
  });

  test('status = เต็มแล้ว when at or above maxStock', () => {
    const result = calculateReplenishment(100, 10, 100);
    expect(result.status).toBe('เต็มแล้ว');
    expect(result.canReplenish).toBe(0);
  });

  test('boundary: current exactly at minStock counts as "ยังเติมได้", not "ต้องเติมทันที"', () => {
    const result = calculateReplenishment(10, 10, 100);
    expect(result.status).toBe('ยังเติมได้');
  });

  test('handles minStock === maxStock without contradictory status', () => {
    const result = calculateReplenishment(10, 10, 10);
    expect(result.status).toBe('เต็มแล้ว');
    expect(result.canReplenish).toBe(0);
  });
});
