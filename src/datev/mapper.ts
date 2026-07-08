import type { DatevBooking, DatevDataset, DatevHeader } from '../parser/types.js';
import type { AccountPosting, FiscalYearDetails } from './types.js';

const isoDate = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  // Die API liefert ISO-Daten, teils mit Zeitanteil.
  return value.slice(0, 10);
};

export const mapAccountPosting = (posting: AccountPosting, index: number): DatevBooking => {
  const debit = posting.amountDebit ?? 0;
  const credit = posting.amountCredit ?? 0;

  return {
    bookingDate: isoDate(posting.date),
    dueDate: undefined,
    account: posting.accountNumber !== undefined ? String(posting.accountNumber) : '',
    contraAccount:
      posting.contraAccountNumber !== undefined ? String(posting.contraAccountNumber) : '',
    amount: debit || credit,
    direction: debit ? 'S' : 'H',
    bookingText: posting.postingDescription ?? '',
    documentField1: posting.documentField1 ?? '',
    documentField2: posting.documentField2 ?? '',
    currency: posting.currencyCode ?? 'EUR',
    invoiceReference: undefined,
    isOpenItem: false,
    rowNumber: index + 1,
    raw: Object.fromEntries(
      Object.entries(posting).map(([key, value]) => [key, value === undefined ? '' : String(value)])
    )
  };
};

export const buildCloudDataset = (
  clientId: string,
  clientName: string | undefined,
  fiscalYearId: number,
  fiscalYear: FiscalYearDetails | undefined,
  postings: AccountPosting[]
): DatevDataset => {
  const header: DatevHeader = {
    advisorNumber: clientId.split('-')[0] ?? '',
    clientNumber: clientId.split('-')[1] ?? '',
    fiscalYearStart: isoDate(fiscalYear?.yearBegin) || String(fiscalYearId),
    accountLength: fiscalYear?.accountLength ?? 4,
    accountFramework: fiscalYear?.accountSystem !== undefined ? `SKR${fiscalYear.accountSystem}` : '',
    dateFrom: isoDate(fiscalYear?.yearBegin),
    dateTo: isoDate(fiscalYear?.yearEnd),
    consultantName: undefined,
    clientName,
    rawLine1: [],
    rawLine2: []
  };

  // Eröffnungsbilanz-Buchungen würden Saldo-Fragen verfälschen, wenn der
  // Nutzer nur nach Bewegungen fragt — sie bleiben aber im Datensatz, damit
  // Salden stimmen. Kennzeichnung steckt in raw.isOpeningBalancePosting.
  const bookings = postings.map((posting, index) => mapAccountPosting(posting, index));

  return {
    filePath: `datev-cloud://${clientId}/${fiscalYearId}`,
    header,
    columns: [],
    bookings,
    loadedAt: new Date().toISOString()
  };
};
