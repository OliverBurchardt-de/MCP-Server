/**
 * Handgeschriebene TypeScript-Typen für die von uns genutzten DATEV-Antworten.
 *
 * @remarks
 * Bewusst nur die tatsächlich verwendeten Felder — die vollständigen Schemas
 * (z. B. ~40 Felder je Buchungssatz) stehen in den OpenAPI-Specs unter
 * `docs/openapi/cloud/`. Feldnamen entsprechen exakt der DATEV-API (camelCase).
 */

/** Ein Mandant laut accounting-clients-API. */
export interface CloudClient {
  id: string;
  name?: string;
  client_number?: number;
  consultant_number?: number;
  services?: Array<{ name?: string; scopes?: string[] }>;
}

/** Stammdaten eines Wirtschaftsjahres (Accounting Data Exchange). */
export interface FiscalYearDetails {
  yearBegin?: string;
  yearEnd?: string;
  accountLength?: number;
  /** Kontenrahmen als Zahl/Text (z. B. `3` bzw. `4` für SKR03/SKR04). */
  accountSystem?: number | string;
  currencyCode?: string;
  taxationMethod?: string;
}

/**
 * Ein einzelner Buchungssatz.
 *
 * @remarks
 * Genau eines von `amountDebit`/`amountCredit` ist gesetzt und bestimmt so
 * Soll (S) bzw. Haben (H). Der Index-Signaturteil hält die vielen weiteren
 * DATEV-Felder zugänglich, ohne sie einzeln zu typisieren.
 */
export interface AccountPosting {
  accountNumber?: number;
  contraAccountNumber?: number;
  amountDebit?: number;
  amountCredit?: number;
  date?: string;
  postingDescription?: string;
  documentField1?: string;
  documentField2?: string;
  currencyCode?: string;
  /** Kennzeichen für Eröffnungsbilanz-Buchungen. */
  isOpeningBalancePosting?: boolean;
  recordType?: string;
  taxRate?: number;
  /** Alle weiteren, hier nicht einzeln typisierten DATEV-Felder. */
  [key: string]: unknown;
}

/** Monatswert innerhalb eines Summen-/Saldenlisten-Eintrags. */
export interface SumsAndBalancesMonthValue {
  /** Wirtschaftsjahresmonat 1–12 (nicht der Kalendermonat!). */
  fiscalYearMonth?: number;
  monthlyBalance?: number;
  monthlyBalanceDebitCreditIdentifier?: string;
}

/** Ein Konto in der Summen- und Saldenliste. */
export interface SumsAndBalancesEntry {
  accountNumber?: number;
  caption?: string;
  balance?: number;
  balanceDebitCreditIdentifier?: string;
  annualValueDebit?: number;
  annualValueCredit?: number;
  openingBalanceDebit?: number;
  openingBalanceCredit?: number;
  sumsAndBalancesMonthValues?: SumsAndBalancesMonthValue[];
}

/** Ein Sachkonto (general-ledger-account) mit Nummer und Bezeichnung. */
export interface GeneralLedgerAccount {
  accountNumber?: number;
  caption?: string;
}
