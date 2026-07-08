import fs from 'node:fs';
import iconv from 'iconv-lite';
import { parse } from 'csv-parse/sync';
import type { DatevBooking, DatevDataset, DatevHeader } from './types.js';

const normalizeDate = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
};

const parseAmount = (value: string): number => {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  if (!normalized) {
    return 0;
  }

  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
};

const accountTypeFrom = (account: string): 'debtor' | 'creditor' | undefined => {
  const numeric = Number.parseInt(account, 10);
  if (Number.isNaN(numeric)) {
    return undefined;
  }

  if (numeric >= 10000 && numeric <= 69999) {
    return 'debtor';
  }

  if (numeric >= 70000 && numeric <= 99999) {
    return 'creditor';
  }

  return undefined;
};

const mapLegacyHeader = (line1: string[], line2: string[]): DatevHeader => {
  const keys = line1.map((value) => value.trim());
  const values = line2.map((value) => value.trim());
  const get = (key: string): string => values[keys.indexOf(key)] ?? '';

  return {
    advisorNumber: get('Beraternummer'),
    clientNumber: get('Mandantennummer'),
    fiscalYearStart: normalizeDate(get('WJ-Beginn')) ?? get('WJ-Beginn'),
    accountLength: Number.parseInt(get('Sachkontenlänge'), 10) || 4,
    accountFramework: get('Kontenrahmen'),
    dateFrom: normalizeDate(get('Datum von')) ?? '',
    dateTo: normalizeDate(get('Datum bis')) ?? '',
    consultantName: get('Beratername') || undefined,
    clientName: get('Mandantenname') || undefined,
    rawLine1: line1,
    rawLine2: line2
  };
};

// Offizieller DATEV-Format-Header (EXTF/DTVF, z. B. Formatversion 700):
// Zeile 1 ist positional. Relevante Felder (1-basiert):
// 11 Beraternummer, 12 Mandantennummer, 13 WJ-Beginn, 14 Sachkontenlänge,
// 15 Datum von, 16 Datum bis, 17 Bezeichnung, 27 SKR.
const mapOfficialHeader = (line1: string[], line2: string[]): DatevHeader => {
  const get = (index: number): string => (line1[index] ?? '').trim();
  const skr = get(26);

  return {
    advisorNumber: get(10),
    clientNumber: get(11),
    fiscalYearStart: normalizeDate(get(12)) ?? get(12),
    accountLength: Number.parseInt(get(13), 10) || 4,
    accountFramework: skr ? (skr.startsWith('SKR') ? skr : `SKR${skr}`) : '',
    dateFrom: normalizeDate(get(14)) ?? '',
    dateTo: normalizeDate(get(15)) ?? '',
    consultantName: undefined,
    clientName: get(16) || undefined,
    rawLine1: line1,
    rawLine2: line2
  };
};

// Belegdatum im offiziellen Buchungsstapel ist TTMM (ohne Jahr). Das Jahr
// stammt aus dem WJ-Beginn; bei abweichendem Wirtschaftsjahr liegen Monate
// vor dem WJ-Beginn-Monat im Folgejahr.
const normalizeDocumentDate = (value: string, fiscalYearStart: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const iso = normalizeDate(trimmed);
  if (iso) {
    return iso;
  }

  if (/^\d{3,4}$/.test(trimmed)) {
    const padded = trimmed.padStart(4, '0');
    const day = padded.slice(0, 2);
    const month = padded.slice(2, 4);
    const wjYear = Number.parseInt(fiscalYearStart.slice(0, 4), 10);
    const wjMonth = Number.parseInt(fiscalYearStart.slice(5, 7), 10) || 1;
    if (!Number.isFinite(wjYear)) {
      return '';
    }
    const year = Number.parseInt(month, 10) < wjMonth ? wjYear + 1 : wjYear;
    return `${year}-${month}-${day}`;
  }

  return '';
};

const pick = (record: Record<string, string>, ...names: string[]): string => {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
};

const mapBookings = (
  rows: string[][],
  columns: string[],
  header: DatevHeader,
  firstDataLine: number
): DatevBooking[] =>
  rows.map((row, index) => {
    const record = Object.fromEntries(
      columns.map((column, columnIndex) => [column, (row[columnIndex] ?? '').trim()])
    );
    const account = pick(record, 'Konto', 'Sachkonto');
    const contraAccount = pick(record, 'Gegenkonto (ohne BU-Schlüssel)', 'Gegenkonto');
    const dueDate = normalizeDate(pick(record, 'Fälligkeit', 'Faelligkeit'));
    const rawDate = pick(record, 'Belegdatum', 'Buchungsdatum', 'Datum');
    const bookingDate =
      normalizeDate(rawDate) ?? normalizeDocumentDate(rawDate, header.fiscalYearStart);
    const amount = parseAmount(pick(record, 'Umsatz (ohne Soll/Haben-Kz)', 'Umsatz', 'Betrag') || '0');
    const direction =
      (pick(record, 'Soll/Haben-Kennzeichen', 'Soll/Haben', 'Saldo') || 'S').toUpperCase() === 'H'
        ? 'H'
        : 'S';
    const openItemFlag = (record['Offener Posten'] || '').toLowerCase();

    return {
      bookingDate,
      dueDate,
      account,
      contraAccount,
      amount,
      direction,
      bookingText: record.Buchungstext || '',
      documentField1: pick(record, 'Belegfeld 1', 'Belegfeld1'),
      documentField2: pick(record, 'Belegfeld 2', 'Belegfeld2'),
      currency: pick(record, 'WKZ Umsatz', 'Währung') || 'EUR',
      invoiceReference: record.Referenz || undefined,
      isOpenItem:
        openItemFlag === 'ja' ||
        openItemFlag === 'true' ||
        openItemFlag === '1' ||
        accountTypeFrom(account) !== undefined,
      rowNumber: index + firstDataLine,
      raw: record
    };
  });

export const parseDatevExtfFile = (filePath: string): DatevDataset => {
  const buffer = fs.readFileSync(filePath);
  const content = iconv.decode(buffer, 'latin1');
  const rows = parse(content, {
    delimiter: ';',
    relax_column_count: true,
    skip_empty_lines: true,
    bom: false,
    trim: false
  }) as string[][];

  const marker = (rows[0]?.[0] ?? '').trim().replace(/^"|"$/g, '');
  const isOfficialFormat = marker === 'EXTF' || marker === 'DTVF';

  if (rows.length < (isOfficialFormat ? 2 : 3)) {
    throw new Error('Invalid EXTF file: too few lines');
  }

  if (isOfficialFormat) {
    // Offizielles DATEV-Format: Zeile 1 = positionaler Header,
    // Zeile 2 = Spaltenüberschriften, ab Zeile 3 Buchungen.
    const line1 = rows[0] ?? [];
    const columns = (rows[1] ?? []).map((value) => value.trim());
    const header = mapOfficialHeader(line1, rows[1] ?? []);
    const bookings = mapBookings(rows.slice(2), columns, header, 3);

    return { filePath, header, columns, bookings, loadedAt: new Date().toISOString() };
  }

  // Vereinfachtes Schlüssel/Wert-Format: Zeile 1 = Header-Feldnamen,
  // Zeile 2 = Header-Werte, Zeile 3 = Spaltenüberschriften, ab Zeile 4 Buchungen.
  const line1 = rows[0] ?? [];
  const line2 = rows[1] ?? [];
  const columns = (rows[2] ?? []).map((value) => value.trim());
  const header = mapLegacyHeader(line1, line2);
  const bookings = mapBookings(rows.slice(3), columns, header, 4);

  return { filePath, header, columns, bookings, loadedAt: new Date().toISOString() };
};

export const getPersonAccountType = accountTypeFrom;
