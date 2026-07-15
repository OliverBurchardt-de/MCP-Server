/**
 * Übersetzt Cloud-Buchungssätze in das gemeinsame {@link DatevBooking}-Modell.
 *
 * Kernidee der Architektur: Egal ob die Daten aus einer EXTF-Datei oder aus der
 * DATEV-Cloud stammen — sie landen im selben internen Modell. So arbeiten die
 * Analyse-Tools (`get_account_balance`, `get_open_items`, …) unverändert auf
 * beiden Quellen.
 */
import type {
  DatevBooking,
  DatevDataset,
  DatevHeader,
} from '../parser/types.js';
import { datevAccountToDisplay } from './account.js';
import type { AccountPosting, FiscalYearDetails } from './types.js';

/** Kürzt einen ISO-Zeitstempel auf das reine Datum (`JJJJ-MM-TT`). */
const isoDate = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  // Die API liefert ISO-Daten, teils mit Zeitanteil.
  return value.slice(0, 10);
};

/**
 * Wandelt einen einzelnen Cloud-Buchungssatz in ein {@link DatevBooking}.
 *
 * @param posting - Buchungssatz aus der Accounting-Data-Exchange-API.
 * @param index - Position in der Liste; ergibt die 1-basierte `rowNumber`.
 * @returns Das interne Buchungsobjekt.
 * @remarks Genau eines von `amountDebit`/`amountCredit` ist gesetzt; daraus
 *   leiten wir Betrag und Soll/Haben-Richtung ab.
 */
export const mapAccountPosting = (
  posting: AccountPosting,
  index: number
): DatevBooking => {
  const debit = posting.amountDebit ?? 0;
  const credit = posting.amountCredit ?? 0;

  return {
    bookingDate: isoDate(posting.date),
    dueDate: undefined,
    // DATEV liefert Kontonummern technisch (Anzeigenummer + 4 Nullen). Wir
    // normalisieren hier an der Grenze auf die Anzeigeform, damit alle
    // Analyse-Tools (Saldo, offene Posten, Filter) mit „1200"/„10400" statt
    // „12000000"/„104000000" arbeiten.
    account:
      posting.accountNumber !== undefined
        ? datevAccountToDisplay(posting.accountNumber)
        : '',
    contraAccount:
      posting.contraAccountNumber !== undefined
        ? datevAccountToDisplay(posting.contraAccountNumber)
        : '',
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
      Object.entries(posting).map(([key, value]) => [
        key,
        value === undefined ? '' : String(value),
      ])
    ),
  };
};

/**
 * Baut aus Cloud-Buchungen einen vollständigen {@link DatevDataset}.
 *
 * @param clientId - Mandant `Beraternummer-Mandantennummer`; wird für den
 *   Header aufgeteilt.
 * @param clientName - Mandantenname (Komfort, optional).
 * @param fiscalYearId - Wirtschaftsjahr `JJJJMMTT` (Fallback für den Header).
 * @param fiscalYear - Stammdaten des Wirtschaftsjahres (optional).
 * @param postings - Die zu übernehmenden Buchungssätze.
 * @returns Ein Datensatz mit synthetischem Header und gemappten Buchungen; die
 *   `filePath` ist eine `datev-cloud://`-Pseudo-URL als Store-Schlüssel.
 */
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
    accountFramework:
      fiscalYear?.accountSystem !== undefined
        ? `SKR${fiscalYear.accountSystem}`
        : '',
    dateFrom: isoDate(fiscalYear?.yearBegin),
    dateTo: isoDate(fiscalYear?.yearEnd),
    consultantName: undefined,
    clientName,
    rawLine1: [],
    rawLine2: [],
  };

  // Eröffnungsbilanz-Buchungen würden Saldo-Fragen verfälschen, wenn der
  // Nutzer nur nach Bewegungen fragt — sie bleiben aber im Datensatz, damit
  // Salden stimmen. Kennzeichnung steckt in raw.isOpeningBalancePosting.
  const bookings = postings.map((posting, index) =>
    mapAccountPosting(posting, index)
  );

  return {
    filePath: `datev-cloud://${clientId}/${fiscalYearId}`,
    header,
    columns: [],
    bookings,
    loadedAt: new Date().toISOString(),
  };
};
