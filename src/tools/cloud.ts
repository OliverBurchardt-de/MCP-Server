import { z } from 'zod';
import { config as defaultConfig, type DatevConfig } from '../config.js';
import type { FetchLike } from '../auth/oauth.js';
import { getLoginState, startLoginFlow } from '../auth/loopback.js';
import { NotLoggedInError, TokenManager } from '../auth/token-manager.js';
import { DatevHttpClient } from '../datev/http.js';
import { AccountPostingsJobRunner } from '../datev/jobs.js';
import { buildCloudDataset } from '../datev/mapper.js';
import type {
  CloudClient,
  FiscalYearDetails,
  SumsAndBalancesEntry
} from '../datev/types.js';
import { datevStore } from '../store/memory.js';

const MAX_RESULT_ROWS = 200;

export const datevListClientsSchema = {
  search: z.string().optional().describe('Filtert nach Namensbestandteil oder Nummer'),
  skip: z.number().int().min(0).optional(),
  top: z.number().int().min(1).max(100).optional()
};

export const datevListFiscalYearsSchema = {
  clientId: z
    .string()
    .regex(/^\d{4,7}-\d{1,5}$/, 'Format: Beraternummer-Mandantennummer, z. B. 455148-1')
    .describe('Mandanten-ID im Format Beraternummer-Mandantennummer (aus datev_list_clients)')
};

export const datevLoadFromCloudSchema = {
  clientId: datevListFiscalYearsSchema.clientId,
  fiscalYearId: z
    .number()
    .int()
    .min(19920101)
    .max(20991231)
    .describe('Wirtschaftsjahr-ID als Zahl JJJJMMTT (aus datev_list_fiscal_years), z. B. 20260101')
};

export const datevGetSumsAndBalancesSchema = {
  clientId: datevListFiscalYearsSchema.clientId,
  fiscalYearId: datevLoadFromCloudSchema.fiscalYearId,
  accountFrom: z.number().int().optional().describe('Nur Konten ab dieser Kontonummer'),
  accountTo: z.number().int().optional().describe('Nur Konten bis zu dieser Kontonummer'),
  accounts: z.array(z.number().int()).optional().describe('Nur genau diese Kontonummern'),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Nur der Monatswert dieses Wirtschaftsjahresmonats (1-12)')
};

export class CloudTools {
  private readonly tokenManager: TokenManager;
  private readonly http: DatevHttpClient;
  private readonly jobs: AccountPostingsJobRunner;

  constructor(
    private readonly config: DatevConfig = defaultConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.tokenManager = new TokenManager(config, fetchImpl);
    this.http = new DatevHttpClient(config, this.tokenManager, fetchImpl);
    this.jobs = new AccountPostingsJobRunner(config, this.http);
  }

  status(): Record<string, unknown> {
    const loginState = getLoginState();
    return {
      umgebung: this.config.environment,
      appKonfiguriert: Boolean(this.config.clientId && this.config.clientSecret),
      angemeldet: this.tokenManager.isLoggedIn(),
      loginVorgang: loginState.status,
      ...(loginState.status === 'error' ? { loginFehler: loginState.message } : {}),
      geladeneDatensaetze: datevStore.list(),
      hinweis: this.tokenManager.isLoggedIn()
        ? 'Verbunden. Mit datev_list_clients starten.'
        : 'Nicht angemeldet. Mit datev_login die DATEV-Anmeldung starten (oder mit load_datev_file eine Exportdatei nutzen).'
    };
  }

  login(): Record<string, unknown> {
    const authorizeUrl = startLoginFlow(this.config, this.tokenManager, this.fetchImpl);
    return {
      anmeldeUrl: authorizeUrl,
      anleitung:
        'Bitte diese URL im Browser öffnen und mit dem DATEV-Konto anmelden' +
        (this.config.environment === 'sandbox'
          ? ' (Sandbox: Benutzer "Test6" wählen).'
          : ' (SmartLogin oder SmartCard).') +
        ' Nach erfolgreicher Anmeldung zeigt datev_status "angemeldet: true".'
    };
  }

  async listClients(input: {
    search?: string;
    skip?: number;
    top?: number;
  }): Promise<Record<string, unknown>> {
    const clients = await this.http.getJson<CloudClient[]>(
      this.config.accountingClientsBaseUrl,
      '/clients',
      {
        filter: input.search,
        skip: input.skip,
        top: input.top ?? 100
      }
    );

    return {
      anzahl: clients.length,
      mandanten: clients.map((client) => ({
        clientId: client.id,
        name: client.name,
        beraternummer: client.consultant_number,
        mandantennummer: client.client_number,
        dienste: client.services?.map((service) => service.name).filter(Boolean)
      })),
      hinweis:
        'Die clientId (Format Beraternummer-Mandantennummer) wird für alle weiteren DATEV-Tools benötigt.'
    };
  }

  async listFiscalYears(input: { clientId: string }): Promise<Record<string, unknown>> {
    const base = this.config.accountingDataExchangeBaseUrl;
    const { items: fiscalYearIds } = await this.http.getNdjson<number>(
      base,
      `/clients/${input.clientId}/fiscal-years`
    );

    const details = await Promise.all(
      fiscalYearIds.slice(0, 12).map(async (fiscalYearId) => {
        try {
          const detail = await this.http.getJson<FiscalYearDetails>(
            base,
            `/clients/${input.clientId}/fiscal-years/${fiscalYearId}`
          );
          return {
            fiscalYearId,
            beginn: detail.yearBegin?.slice(0, 10),
            ende: detail.yearEnd?.slice(0, 10),
            kontenrahmen: detail.accountSystem !== undefined ? `SKR${detail.accountSystem}` : undefined,
            sachkontenlaenge: detail.accountLength,
            waehrung: detail.currencyCode
          };
        } catch {
          return { fiscalYearId };
        }
      })
    );

    return {
      wirtschaftsjahre: details,
      hinweis:
        'Die fiscalYearId für datev_load_from_cloud und datev_get_sums_and_balances verwenden.'
    };
  }

  async loadFromCloud(input: {
    clientId: string;
    fiscalYearId: number;
  }): Promise<Record<string, unknown>> {
    const result = await this.jobs.run(input.clientId, input.fiscalYearId);

    if (result.status === 'running') {
      return {
        status: 'in_arbeit',
        jobId: result.jobId,
        hinweis: result.hint
      };
    }

    let clientName: string | undefined;
    let fiscalYear: FiscalYearDetails | undefined;
    try {
      const client = await this.http.getJson<CloudClient>(
        this.config.accountingClientsBaseUrl,
        `/clients/${input.clientId}`
      );
      clientName = client.name;
    } catch {
      // Name ist nur Komfort — Laden nicht daran scheitern lassen.
    }
    try {
      fiscalYear = await this.http.getJson<FiscalYearDetails>(
        this.config.accountingDataExchangeBaseUrl,
        `/clients/${input.clientId}/fiscal-years/${input.fiscalYearId}`
      );
    } catch {
      // Details sind optional.
    }

    const dataset = buildCloudDataset(
      input.clientId,
      clientName,
      input.fiscalYearId,
      fiscalYear,
      result.postings
    );
    datevStore.set(dataset, `${input.clientId}:${input.fiscalYearId}`);

    return {
      status: 'geladen',
      mandant: input.clientId,
      mandantName: clientName ?? null,
      wirtschaftsjahr: input.fiscalYearId,
      buchungen: dataset.bookings.length,
      gesamtAnzahl: result.totalCount,
      abgeschnitten: result.truncated,
      hinweis:
        'Die Buchungen sind jetzt geladen. Fragen können mit get_account_balance, get_open_items, list_bookings und search_documents beantwortet werden.'
    };
  }

  async getSumsAndBalances(input: {
    clientId: string;
    fiscalYearId: number;
    accountFrom?: number;
    accountTo?: number;
    accounts?: number[];
    month?: number;
  }): Promise<Record<string, unknown>> {
    const { items } = await this.http.getNdjson<SumsAndBalancesEntry>(
      this.config.accountingDataExchangeBaseUrl,
      `/clients/${input.clientId}/fiscal-years/${input.fiscalYearId}/sums-and-balances`
    );

    const accountSet = input.accounts ? new Set(input.accounts) : undefined;
    const filtered = items.filter((entry) => {
      const account = entry.accountNumber ?? -1;
      if (accountSet && !accountSet.has(account)) {
        return false;
      }
      if (input.accountFrom !== undefined && account < input.accountFrom) {
        return false;
      }
      if (input.accountTo !== undefined && account > input.accountTo) {
        return false;
      }
      return true;
    });

    const rows = filtered.slice(0, MAX_RESULT_ROWS).map((entry) => ({
      konto: entry.accountNumber,
      bezeichnung: entry.caption,
      saldo: entry.balance,
      sollHaben: entry.balanceDebitCreditIdentifier,
      jahreswertSoll: entry.annualValueDebit,
      jahreswertHaben: entry.annualValueCredit,
      ebWertSoll: entry.openingBalanceDebit,
      ebWertHaben: entry.openingBalanceCredit,
      ...(input.month !== undefined
        ? {
            monat: input.month,
            monatssaldo: entry.sumsAndBalancesMonthValues?.find(
              (value) => value.fiscalYearMonth === input.month
            )?.monthlyBalance
          }
        : {})
    }));

    return {
      gesamtAnzahl: filtered.length,
      angezeigt: rows.length,
      ...(filtered.length > rows.length
        ? { hinweis: 'Ausgabe gekürzt — bitte über Kontonummern-Filter eingrenzen.' }
        : {}),
      salden: rows
    };
  }
}

export const isNotLoggedInError = (error: unknown): boolean => error instanceof NotLoggedInError;
