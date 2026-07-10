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

describe('get_open_items with personenkonto on the contra side', () => {
  beforeEach(() => {
    datevStore.clear();
    loadDatevFile({ path: path.resolve('test/fixtures/sample-personenkonten.csv') });
  });

  it('recognises both a debtor (primary) and a creditor (contra) posting', () => {
    const result = getOpenItems({});

    // Kreditor 70013 (Gegenkonto) und Debitor 10000 (Hauptkonto); Sachkonto ignoriert.
    expect(result.count).toBe(2);
    const creditor = result.items.find((item) => item.account === '70013');
    const debtor = result.items.find((item) => item.account === '10000');

    expect(creditor?.accountType).toBe('creditor');
    expect(creditor?.amount).toBeLessThan(0); // Verbindlichkeit
    expect(debtor?.accountType).toBe('debtor');
    expect(debtor?.amount).toBeGreaterThan(0); // Forderung
  });

  it('filters to creditors only', () => {
    const result = getOpenItems({ type: 'creditor' });

    expect(result.count).toBe(1);
    expect(result.items[0]?.account).toBe('70013');
  });
});
