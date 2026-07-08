/**
 * Das gemeinsame Datenmodell für DATEV-Buchhaltungsdaten.
 *
 * @remarks
 * Zentral für die Architektur: Sowohl der EXTF-Dateiparser als auch das
 * Cloud-Modul erzeugen diese Typen. Alle Analyse-Tools arbeiten ausschließlich
 * darauf und sind damit von der Datenquelle unabhängig.
 */

/** Kopfdaten eines Datensatzes (Mandant, Zeitraum, Kontenrahmen). */
export interface DatevHeader {
  /** Beraternummer. */
  advisorNumber: string;
  /** Mandantennummer. */
  clientNumber: string;
  /** Beginn des Wirtschaftsjahres (`JJJJ-MM-TT`). */
  fiscalYearStart: string;
  /** Länge der Sachkontonummern (meist 4). */
  accountLength: number;
  /** Kontenrahmen, z. B. `SKR03` oder `SKR04`. */
  accountFramework: string;
  /** Beginn des Datenzeitraums (`JJJJ-MM-TT`). */
  dateFrom: string;
  /** Ende des Datenzeitraums (`JJJJ-MM-TT`). */
  dateTo: string;
  consultantName?: string;
  clientName?: string;
  /** Rohzeile 1 der Datei (nur beim Dateiimport befüllt). */
  rawLine1: string[];
  /** Rohzeile 2 der Datei (nur beim Dateiimport befüllt). */
  rawLine2: string[];
}

/** Ein einzelner, normalisierter Buchungssatz. */
export interface DatevBooking {
  /** Buchungsdatum (`JJJJ-MM-TT`). */
  bookingDate: string;
  /** Fälligkeit bei offenen Posten (`JJJJ-MM-TT`), sonst `undefined`. */
  dueDate?: string;
  /** Bebuchtes Konto (Sach- oder Personenkonto). */
  account: string;
  /** Gegenkonto. */
  contraAccount: string;
  /** Betrag (immer positiv; Vorzeichen ergibt sich aus `direction`). */
  amount: number;
  /** Buchungsrichtung: `S` = Soll, `H` = Haben. */
  direction: 'S' | 'H';
  bookingText: string;
  documentField1: string;
  documentField2: string;
  /** Währung, meist `EUR`. */
  currency: string;
  invoiceReference?: string;
  /** `true`, wenn es sich um einen offenen Posten handelt. */
  isOpenItem: boolean;
  /** 1-basierte Herkunftszeile (Datei) bzw. Listenposition (Cloud). */
  rowNumber: number;
  /** Alle Rohfelder als Zeichenketten (für Nachschlagen/Debugging). */
  raw: Record<string, string>;
}

/** Ein geladener Datensatz aus einer Quelle (Datei oder Cloud). */
export interface DatevDataset {
  /** Quell-Schlüssel: Dateipfad oder `datev-cloud://…`-Pseudo-URL. */
  filePath: string;
  header: DatevHeader;
  /** Spaltenüberschriften (nur beim Dateiimport). */
  columns: string[];
  bookings: DatevBooking[];
  /** Ladezeitpunkt (ISO-8601). */
  loadedAt: string;
}

/** Ein offener Posten (Debitor/Kreditor) als Ergebnis von `get_open_items`. */
export interface OpenItem {
  account: string;
  /** `debtor` = Kunde (Forderung), `creditor` = Lieferant (Verbindlichkeit). */
  accountType: 'debtor' | 'creditor';
  /** Vorzeichenbehafteter Betrag (Soll positiv, Haben negativ). */
  amount: number;
  dueDate?: string;
  bookingDate: string;
  bookingText: string;
  documentField1: string;
  documentField2: string;
  /** `true`, wenn die Fälligkeit vor dem Stichtag liegt. */
  overdue: boolean;
}

/** Filterkriterien für `list_bookings`. */
export interface BookingFilter {
  account?: string;
  /** Von-Datum inklusive (`JJJJ-MM-TT`). */
  from?: string;
  /** Bis-Datum inklusive (`JJJJ-MM-TT`). */
  to?: string;
  /** Mindestbetrag (absolut). */
  minAmount?: number;
  /** Volltext in Buchungstext/Belegfeldern. */
  text?: string;
}
