export interface CloudClient {
  id: string;
  name?: string;
  client_number?: number;
  consultant_number?: number;
  services?: Array<{ name?: string; scopes?: string[] }>;
}

export interface FiscalYearDetails {
  yearBegin?: string;
  yearEnd?: string;
  accountLength?: number;
  accountSystem?: number | string;
  currencyCode?: string;
  taxationMethod?: string;
}

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
  isOpeningBalancePosting?: boolean;
  recordType?: string;
  taxRate?: number;
  [key: string]: unknown;
}

export interface SumsAndBalancesMonthValue {
  fiscalYearMonth?: number;
  monthlyBalance?: number;
  monthlyBalanceDebitCreditIdentifier?: string;
}

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

export interface GeneralLedgerAccount {
  accountNumber?: number;
  caption?: string;
}
