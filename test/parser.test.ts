import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDatevExtfFile } from '../src/parser/extf.js';

const fixturePath = path.resolve('test/fixtures/sample.extf');

describe('parseDatevExtfFile', () => {
  it('parses header metadata correctly', () => {
    const dataset = parseDatevExtfFile(fixturePath);

    expect(dataset.header.advisorNumber).toBe('99999');
    expect(dataset.header.clientNumber).toBe('10001');
    expect(dataset.header.fiscalYearStart).toBe('2026-01-01');
    expect(dataset.header.accountFramework).toBe('SKR03');
    expect(dataset.header.accountLength).toBe(4);
    expect(dataset.header.clientName).toBe('Müller & Söhne GmbH');
    expect(dataset.header.dateFrom).toBe('2026-01-01');
    expect(dataset.header.dateTo).toBe('2026-03-31');
  });

  it('parses bookings and preserves latin1 umlauts', () => {
    const dataset = parseDatevExtfFile(fixturePath);

    expect(dataset.bookings).toHaveLength(22);
    expect(dataset.bookings[5]?.account).toBe('10000');
    expect(dataset.bookings[8]?.bookingText).toContain('Umlaut');
    expect(dataset.bookings[8]?.documentField2).toBe('Küche Öl');
    expect(dataset.bookings[9]?.bookingText).toContain('Ähre');
  });
});

describe('parseDatevExtfFile with official EXTF header (Formatversion 700)', () => {
  const officialPath = path.resolve('test/fixtures/sample-extf700.csv');

  it('parses the positional header', () => {
    const dataset = parseDatevExtfFile(officialPath);

    expect(dataset.header.advisorNumber).toBe('99999');
    expect(dataset.header.clientNumber).toBe('10001');
    expect(dataset.header.fiscalYearStart).toBe('2026-01-01');
    expect(dataset.header.accountLength).toBe(4);
    expect(dataset.header.accountFramework).toBe('SKR03');
    expect(dataset.header.dateFrom).toBe('2026-01-01');
    expect(dataset.header.dateTo).toBe('2026-03-31');
    expect(dataset.header.clientName).toBe('Q1-Stapel');
  });

  it('maps official booking columns and TTMM Belegdatum', () => {
    const dataset = parseDatevExtfFile(officialPath);

    expect(dataset.bookings).toHaveLength(5);

    const first = dataset.bookings[0];
    expect(first?.amount).toBe(2500);
    expect(first?.direction).toBe('S');
    expect(first?.account).toBe('1200');
    expect(first?.contraAccount).toBe('8400');
    expect(first?.bookingDate).toBe('2026-01-03');
    expect(first?.documentField1).toBe('RE-1001');
    expect(first?.currency).toBe('EUR');

    const creditor = dataset.bookings[3];
    expect(creditor?.account).toBe('70000');
    expect(creditor?.direction).toBe('H');
    expect(creditor?.bookingDate).toBe('2026-02-18');
    expect(creditor?.bookingText).toBe('Lieferantenrechnung Ähre');
    expect(creditor?.isOpenItem).toBe(true);
  });
});
