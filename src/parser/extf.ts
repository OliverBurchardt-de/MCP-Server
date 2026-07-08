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

const mapHeader = (line1: string[], line2: string[]): DatevHeader => {
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

  if (rows.length < 3) {
    throw new Error('Invalid EXTF file: expected at least 3 lines');
  }

  const line1 = rows[0] ?? [];
  const line2 = rows[1] ?? [];
  const columns = (rows[2] ?? []).map((value) => value.trim());
  const header = mapHeader(line1, line2);

  const bookings: DatevBooking[] = rows.slice(3).map((row, index) => {
    const record = Object.fromEntries(columns.map((column, columnIndex) => [column, (row[columnIndex] ?? '').trim()]));
    const account = record.Konto || record.Sachkonto || '';
    const contraAccount = record.Gegenkonto || '';
    const dueDate = normalizeDate(record['Fälligkeit'] || record['Faelligkeit'] || '');
    const bookingDate = normalizeDate(record['Buchungsdatum'] || record.Datum || '') ?? '';
    const amount = parseAmount(record.Betrag || '0');
    const direction = (record['Soll/Haben'] || record.Saldo || 'S').toUpperCase() === 'H' ? 'H' : 'S';
    const openItemFlag = (record['Offener Posten'] || '').toLowerCase();

    return {
      bookingDate,
      dueDate,
      account,
      contraAccount,
      amount,
      direction,
      bookingText: record.Buchungstext || '',
      documentField1: record.Belegfeld1 || '',
      documentField2: record.Belegfeld2 || '',
      currency: record.Währung || 'EUR',
      invoiceReference: record.Referenz || undefined,
      isOpenItem:
        openItemFlag === 'ja' ||
        openItemFlag === 'true' ||
        openItemFlag === '1' ||
        accountTypeFrom(account) !== undefined,
      rowNumber: index + 4,
      raw: record
    };
  });

  return {
    filePath,
    header,
    columns,
    bookings,
    loadedAt: new Date().toISOString()
  };
};

export const getPersonAccountType = accountTypeFrom;
