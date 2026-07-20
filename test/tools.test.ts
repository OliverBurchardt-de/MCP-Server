import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccountBalance } from '../src/tools/balance.js';
import { listBookings } from '../src/tools/bookings.js';
import { loadDatevFile, resolveImportPath } from '../src/tools/load.js';
import { getOpenItems } from '../src/tools/openItems.js';
import { searchDocuments } from '../src/tools/search.js';
import { datevStore } from '../src/store/memory.js';
import type { RequestContext } from '../src/context/context.js';

/** Fester Test-Kontext (Kanzlei/Nutzer) für kontextgebundene Store-/Tool-Aufrufe. */
const ctx: RequestContext = {
  principalId: 'test-nutzer',
  organizationId: 'test-kanzlei',
  requestId: 'test-request',
};

const FIXTURES = path.resolve('test/fixtures');
const fixturePath = path.resolve('test/fixtures/sample.extf');

describe('DATEV tools', () => {
  beforeEach(() => {
    datevStore.clear();
    loadDatevFile(ctx, { path: fixturePath }, FIXTURES, true);
  });

  it('loads the file and returns a summary', () => {
    const result = loadDatevFile(ctx, { path: fixturePath }, FIXTURES, true);

    expect(result.bookingCount).toBe(22);
    expect(result.accountFramework).toBe('SKR03');
    expect(result.summary).toContain('Mandant 10001');
  });

  it('calculates account balance for revenue account 8400', () => {
    const result = getAccountBalance(ctx, { account: '8400' });

    expect(result.bookingCount).toBe(6);
    expect(result.balance).toBe(-16295);
    expect(result.lastBookingDate).toBe('2026-03-20');
  });

  it('returns filtered open items and overdue status', () => {
    const result = getOpenItems(ctx, {
      overdueOnly: true,
      referenceDate: '2026-03-10',
    });

    expect(result.count).toBe(4);
    expect(result.items.every((item) => item.overdue)).toBe(true);
    expect(result.items.some((item) => item.account === '10000')).toBe(true);
    expect(result.items.some((item) => item.account === '70000')).toBe(true);
  });

  it('lists bookings using text and amount filters', () => {
    const result = listBookings(ctx, { text: 'Miete', minAmount: 1000 });

    expect(result.count).toBe(3);
    expect(result.items[0]?.bookingDate).toBe('2026-01-12');
  });

  it('searches documents across booking text and beleg fields', () => {
    const result = searchDocuments(ctx, { query: 'RE-1004' });

    expect(result.count).toBe(1);
    expect(result.items[0]?.bookingText).toContain('Folgeauftrag');
  });
});

describe('gezielte Datensatz-Auswahl (dataset-Parameter)', () => {
  const secondKey = 'test/fixtures/second.extf';

  beforeEach(() => {
    datevStore.clear();
    // Erster Datensatz unter seinem Dateipfad-Schlüssel.
    loadDatevFile(ctx, { path: fixturePath }, FIXTURES, true);
    // Zweiter Datensatz unter eigenem Schlüssel; wird damit der aktive.
    const first = datevStore.get(ctx);
    datevStore.set(ctx, { ...first, bookings: [] }, secondKey);
  });

  it('nutzt ohne dataset den aktiven (zuletzt geladenen) Datensatz', () => {
    const result = searchDocuments(ctx, { query: 'RE-1004' });
    // Der aktive (zweite) Datensatz hat keine Buchungen.
    expect(result.count).toBe(0);
  });

  it('greift mit dataset-Schlüssel gezielt auf den ersten Datensatz zu', () => {
    const result = searchDocuments(ctx, {
      query: 'RE-1004',
      dataset: fixturePath,
    });
    expect(result.count).toBe(1);
  });

  it('wirft mit Liste verfügbarer Schlüssel bei unbekanntem dataset', () => {
    expect(() =>
      getAccountBalance(ctx, { account: '8400', dataset: 'nicht-geladen' })
    ).toThrow(/Kein Datensatz "nicht-geladen" geladen/);
  });
});

describe('get_open_items with personenkonto on the contra side', () => {
  beforeEach(() => {
    datevStore.clear();
    loadDatevFile(
      ctx,
      { path: path.resolve('test/fixtures/sample-personenkonten.csv') },
      FIXTURES
    );
  });

  it('recognises both a debtor (primary) and a creditor (contra) posting', () => {
    const result = getOpenItems(ctx, {});

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
    const result = getOpenItems(ctx, { type: 'creditor' });

    expect(result.count).toBe(1);
    expect(result.items[0]?.account).toBe('70013');
  });
});

describe('resolveImportPath (Pfad-Confinement)', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-import-'));
    fs.writeFileSync(path.join(baseDir, 'export.csv'), 'x');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('accepts a file inside the import folder', () => {
    const resolved = resolveImportPath('export.csv', baseDir);
    expect(resolved).toBe(fs.realpathSync(path.join(baseDir, 'export.csv')));
  });

  it('rejects an absolute path outside the import folder', () => {
    expect(() => resolveImportPath('/etc/passwd', baseDir)).toThrow(
      /Zugriff verweigert/
    );
  });

  it('rejects traversal out of the import folder', () => {
    expect(() => resolveImportPath('../secret.csv', baseDir)).toThrow(
      /Zugriff verweigert/
    );
  });

  it('gives a generic error for a missing file', () => {
    expect(() => resolveImportPath('missing.csv', baseDir)).toThrow(
      /Datei nicht gefunden/
    );
  });
});
