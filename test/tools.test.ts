import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAccountBalance } from '../src/tools/balance.js';
import { listBookings } from '../src/tools/bookings.js';
import { loadDatevFile } from '../src/tools/load.js';
import { getOpenItems } from '../src/tools/openItems.js';
import { searchDocuments } from '../src/tools/search.js';
import { datevStore } from '../src/store/memory.js';

const fixturePath = path.resolve('test/fixtures/sample.extf');

describe('DATEV tools', () => {
  beforeEach(() => {
    datevStore.clear();
    loadDatevFile({ path: fixturePath });
  });

  it('loads the file and returns a summary', () => {
    const result = loadDatevFile({ path: fixturePath });

    expect(result.bookingCount).toBe(22);
    expect(result.accountFramework).toBe('SKR03');
    expect(result.summary).toContain('Mandant 10001');
  });

  it('calculates account balance for revenue account 8400', () => {
    const result = getAccountBalance({ account: '8400' });

    expect(result.bookingCount).toBe(6);
    expect(result.balance).toBe(-16295);
    expect(result.lastBookingDate).toBe('2026-03-20');
  });

  it('returns filtered open items and overdue status', () => {
    const result = getOpenItems({
      overdueOnly: true,
      referenceDate: '2026-03-10',
    });

    expect(result.count).toBe(4);
    expect(result.items.every((item) => item.overdue)).toBe(true);
    expect(result.items.some((item) => item.account === '10000')).toBe(true);
    expect(result.items.some((item) => item.account === '70000')).toBe(true);
  });

  it('lists bookings using text and amount filters', () => {
    const result = listBookings({ text: 'Miete', minAmount: 1000 });

    expect(result.count).toBe(3);
    expect(result.items[0]?.bookingDate).toBe('2026-01-12');
  });

  it('searches documents across booking text and beleg fields', () => {
    const result = searchDocuments({ query: 'RE-1004' });

    expect(result.count).toBe(1);
    expect(result.items[0]?.bookingText).toContain('Folgeauftrag');
  });
});
