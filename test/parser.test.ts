import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmount, parseDatevExtfFile } from '../src/parser/extf.js';

const fixturePath = path.resolve('test/fixtures/sample.extf');

describe('parseDatevExtfFile', () => {
  it('parses header metadata correctly', () => {
    const dataset = parseDatevExtfFile(fixturePath, true);

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
    const dataset = parseDatevExtfFile(fixturePath, true);

    expect(dataset.bookings).toHaveLength(22);
    expect(dataset.bookings[5]?.account).toBe('10000');
    expect(dataset.bookings[8]?.bookingText).toContain('Umlaut');
    expect(dataset.bookings[8]?.documentField2).toBe('Küche Öl');
    expect(dataset.bookings[9]?.bookingText).toContain('Ähre');
  });

  it('kennzeichnet einen vollständigen Datei-Import in der Provenance', () => {
    const dataset = parseDatevExtfFile(fixturePath, true);
    expect(dataset.provenance.complete).toBe(true);
    expect(dataset.provenance.truncated).toBe(false);
    expect(dataset.provenance.parseErrors).toBe(0);
    expect(dataset.provenance.loadedCount).toBe(dataset.bookings.length);
  });

  it('lehnt nicht-reguläre Dateien (z. B. ein Verzeichnis) ab', () => {
    expect(() => parseDatevExtfFile(path.resolve('test/fixtures'))).toThrow(
      /reguläre Dateien/
    );
  });

  it('lehnt ein unbekanntes Format ohne Legacy-Freigabe ab', () => {
    // sample.extf hat keine EXTF/DTVF-Kennung → ohne allowLegacy abgelehnt.
    expect(() => parseDatevExtfFile(fixturePath)).toThrow(/EXTF\/DTVF/);
  });
});

describe('parseDatevExtfFile Validierung (offizielles Format)', () => {
  const writeTemp = (lines: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-extf-'));
    const file = path.join(dir, 'stapel.csv');
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  };

  const officialHeader =
    '"EXTF";700;21;"Buchungsstapel";13;20260101120000000;;"RE";"K";"";99999;10001;20260101;4;20260101;20260331;"T";"OB";1;0;0;"EUR";;"";;"";"03"';

  it('lehnt ein ungültiges Soll/Haben-Kennzeichen mit Zeilennummer ab', () => {
    const file = writeTemp([
      officialHeader,
      '"Umsatz (ohne Soll/Haben-Kz)";"Soll/Haben-Kennzeichen";"Konto";"Gegenkonto";"Belegdatum";"Buchungstext"',
      '"100,00";"X";"1200";"8400";"20260101";"Test"',
    ]);
    expect(() => parseDatevExtfFile(file)).toThrow(/Soll\/Haben-Kennzeichen/);
  });

  it('lehnt fehlende Pflichtspalten ab', () => {
    const file = writeTemp([
      officialHeader,
      '"Konto";"Gegenkonto";"Belegdatum";"Buchungstext"',
      '"1200";"8400";"20260101";"Test"',
    ]);
    expect(() => parseDatevExtfFile(file)).toThrow(/Pflichtspalten fehlen/);
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

describe('parseAmount', () => {
  it('parses valid German amounts', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('89,50')).toBe(89.5);
    expect(parseAmount('16295')).toBe(16295);
    expect(parseAmount('-1.000,00')).toBe(-1000);
    expect(parseAmount('')).toBe(0);
  });

  it('rejects clearly malformed amounts instead of silently returning 0', () => {
    // Ein still zu 0 verbuchter Krummwert würde einen Saldo verfälschen.
    expect(() => parseAmount('12.34.56')).toThrow(/nicht interpretierbar/);
    expect(() => parseAmount('1,2,3')).toThrow(/nicht interpretierbar/);
    expect(() => parseAmount('abc')).toThrow(/nicht interpretierbar/);
  });
});

describe('parseDatevExtfFile Fälligkeit (TTMMJJJJ)', () => {
  const personenkontenPath = path.resolve(
    'test/fixtures/sample-personenkonten.csv'
  );

  it('parses a TTMMJJJJ due date into ISO', () => {
    const dataset = parseDatevExtfFile(personenkontenPath);
    const debtorBooking = dataset.bookings.find(
      (booking) => booking.account === '10000'
    );

    // Fälligkeit 14072026 (TT.MM.JJJJ) -> ISO 2026-07-14 (nicht als JJJJMMTT missdeutet).
    expect(debtorBooking?.dueDate).toBe('2026-07-14');
  });
});
