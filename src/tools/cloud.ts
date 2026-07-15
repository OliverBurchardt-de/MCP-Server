/**
 * Implementierung der DATEV-Cloud-Tools.
 *
 * Bündelt Anmeldung, Mandanten-/Wirtschaftsjahr-Abfragen, das Laden von
 * Buchungsdaten (über den Job-Runner) und die Summen-/Saldenliste. Die Klasse
 * hält die zusammengehörigen Bausteine (TokenManager, HTTP-Client, Job-Runner)
 * und wird in {@link file://../server.ts} an die MCP-Tools angebunden.
 *
 * @remarks
 * Alle Methoden geben schlichte Objekte mit **deutschen** Schlüsseln zurück,
 * da diese Antworten direkt von Claude interpretiert und dem Nutzer erklärt
 * werden. Die Zod-Schemas nutzen `describe`, damit Claude die Parameter korrekt
 * befüllt.
 */
import { z } from 'zod';
import { config as defaultConfig, type DatevConfig } from '../config.js';
import type { FetchLike } from '../auth/oauth.js';
import { getLoginState, startLoginFlow } from '../auth/loopback.js';
import { NotLoggedInError, TokenManager } from '../auth/token-manager.js';
import {
  datevAccountToDisplay,
  detectAccountPadding,
} from '../datev/account.js';
import { DatevError } from '../datev/errors.js';
import { DatevHttpClient } from '../datev/http.js';
import { AccountPostingsJobRunner } from '../datev/jobs.js';
import { buildCloudDataset } from '../datev/mapper.js';
import type {
  CloudClient,
  FiscalYearDetails,
  SumsAndBalancesEntry,
} from '../datev/types.js';
import { datevStore } from '../store/memory.js';
import { computeAccountBalance } from './balance.js';

/** Obergrenze der in einer Antwort zurückgegebenen Zeilen (Kontext-Schutz). */
const MAX_RESULT_ROWS = 200;

/** Rundet einen Geldbetrag kaufmännisch auf zwei Nachkommastellen. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Präfix der Pseudo-URL, unter der Cloud-Datensätze im Store liegen. */
const CLOUD_PREFIX = 'datev-cloud://';

/**
 * Erkennt eine Zeitüberschreitung/einen Abbruch beim DATEV-Abruf.
 *
 * @remarks
 * Zwei Quellen: (1) unser client-seitiges Zeitlimit (`AbortSignal.timeout` →
 * `TimeoutError`/`AbortError`) und (2) ein Gateway-Timeout von DATEV selbst
 * (`DatevError` mit Status 504/408). Beides bedeutet praktisch: „DATEV hat zu
 * lange gebraucht" — typisch, wenn die Summen-/Saldenliste erst aufbereitet
 * werden muss.
 */
const isTimeoutError = (error: unknown): boolean => {
  if (error instanceof DatevError) {
    return error.status === 504 || error.status === 408;
  }
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      /timeout|timed out|aborted/i.test(error.message))
  );
};

/**
 * Handlungsleitender Hinweis, wenn die Summen-/Saldenliste nicht rechtzeitig
 * kommt: über den Async-Job-Weg (`datev_load_from_cloud`) an dieselben Daten.
 */
const SUSA_TIMEOUT_HINWEIS =
  'Die Summen-/Saldenliste kam von DATEV nicht rechtzeitig zurück (Zeitüberschreitung). ' +
  'Das passiert, wenn DATEV die Auswertung erst aufbereiten muss. Bitte stattdessen zuerst die ' +
  'Buchungen laden (datev_load_from_cloud für denselben Mandanten und dasselbe Wirtschaftsjahr; ' +
  'bei Status "in_arbeit" nach etwa 30 Sekunden erneut) und die Frage anschließend mit ' +
  'get_account_balance bzw. list_bookings beantworten.';

/** Eingabeschema für `datev_list_clients`. */

export const datevListClientsSchema = {
  search: z
    .string()
    .optional()
    .describe('Filtert nach Namensbestandteil oder Nummer'),
  skip: z.number().int().min(0).optional(),
  top: z.number().int().min(1).max(100).optional(),
};

/** Eingabeschema für `datev_list_fiscal_years` (definiert auch die `clientId`). */
export const datevListFiscalYearsSchema = {
  clientId: z
    .string()
    .regex(
      /^\d{4,7}-\d{1,5}$/,
      'Format: Beraternummer-Mandantennummer, z. B. 455148-1'
    )
    .describe(
      'Mandanten-ID im Format Beraternummer-Mandantennummer (aus datev_list_clients)'
    ),
};

/** Eingabeschema für `datev_load_from_cloud`. */
export const datevLoadFromCloudSchema = {
  clientId: datevListFiscalYearsSchema.clientId,
  fiscalYearId: z
    .number()
    .int()
    .min(19920101)
    .max(20991231)
    .describe(
      'Wirtschaftsjahr-ID als Zahl JJJJMMTT (aus datev_list_fiscal_years), z. B. 20260101'
    ),
};

/** Eingabeschema für `datev_get_sums_and_balances` (mit Konto-/Monatsfiltern). */
export const datevGetSumsAndBalancesSchema = {
  clientId: datevListFiscalYearsSchema.clientId,
  fiscalYearId: datevLoadFromCloudSchema.fiscalYearId,
  accountFrom: z
    .number()
    .int()
    .min(0)
    .max(99999999)
    .optional()
    .describe('Nur Konten ab dieser Kontonummer'),
  accountTo: z
    .number()
    .int()
    .min(0)
    .max(99999999)
    .optional()
    .describe('Nur Konten bis zu dieser Kontonummer'),
  accounts: z
    .array(z.number().int().min(0).max(99999999))
    .max(200)
    .optional()
    .describe('Nur genau diese Kontonummern'),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Nur der Monatswert dieses Wirtschaftsjahresmonats (1-12)'),
};

/** Stellt die Geschäftslogik hinter den DATEV-Cloud-Tools bereit. */
export class CloudTools {
  private readonly tokenManager: TokenManager;
  private readonly http: DatevHttpClient;
  private readonly jobs: AccountPostingsJobRunner;

  /**
   * @param config - Aktive Konfiguration; Standard ist die globale {@link config}.
   * @param fetchImpl - Injizierbare `fetch`-Implementierung (für Tests).
   */
  constructor(
    private readonly config: DatevConfig = defaultConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.tokenManager = new TokenManager(config, fetchImpl);
    this.http = new DatevHttpClient(config, this.tokenManager, fetchImpl);
    this.jobs = new AccountPostingsJobRunner(config, this.http);
  }

  /**
   * `datev_status`: Umgebung, App-/Anmeldezustand und geladene Datensätze.
   *
   * @returns Ein Statusobjekt inkl. handlungsleitendem Hinweis für den Nutzer.
   */
  status(): Record<string, unknown> {
    const loginState = getLoginState();
    return {
      umgebung: this.config.environment,
      appKonfiguriert: Boolean(
        this.config.clientId && this.config.clientSecret
      ),
      angemeldet: this.tokenManager.isLoggedIn(),
      loginVorgang: loginState.status,
      ...(loginState.status === 'error'
        ? { loginFehler: loginState.message }
        : {}),
      geladeneDatensaetze: datevStore.list(),
      hinweis: this.tokenManager.isLoggedIn()
        ? 'Verbunden. Mit datev_list_clients starten.'
        : 'Nicht angemeldet. Mit datev_login die DATEV-Anmeldung starten (oder mit load_datev_file eine Exportdatei nutzen).',
    };
  }

  /**
   * `datev_login`: startet den OAuth-Flow und liefert die Login-URL.
   *
   * @returns Die Anmelde-URL plus eine umgebungsabhängige Anleitung.
   * @throws Error - wenn die App nicht konfiguriert ist (siehe {@link startLoginFlow}).
   */
  login(): Record<string, unknown> {
    const authorizeUrl = startLoginFlow(
      this.config,
      this.tokenManager,
      this.fetchImpl
    );
    return {
      anmeldeUrl: authorizeUrl,
      anleitung:
        'Bitte diese URL im Browser öffnen und mit dem DATEV-Konto anmelden' +
        (this.config.environment === 'sandbox'
          ? ' (Sandbox: Benutzer "Test6" wählen).'
          : ' (SmartLogin oder SmartCard).') +
        ' Nach erfolgreicher Anmeldung zeigt datev_status "angemeldet: true".',
    };
  }

  /**
   * `datev_list_clients`: Mandanten des angemeldeten Nutzers.
   *
   * @param input - Optionaler Namens-/Nummernfilter und Paginierung.
   * @returns Anzahl und Liste der Mandanten inkl. `clientId` für Folge-Tools.
   */
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
        top: input.top ?? 100,
      }
    );

    return {
      anzahl: clients.length,
      mandanten: clients.map((client) => ({
        clientId: client.id,
        name: client.name,
        beraternummer: client.consultant_number,
        mandantennummer: client.client_number,
        dienste: client.services
          ?.map((service) => service.name)
          .filter(Boolean),
      })),
      hinweis:
        'Die clientId (Format Beraternummer-Mandantennummer) wird für alle weiteren DATEV-Tools benötigt.',
    };
  }

  /**
   * `datev_list_fiscal_years`: Wirtschaftsjahre eines Mandanten mit Stammdaten.
   *
   * @param input - Mandant (`clientId`).
   * @returns Liste der Wirtschaftsjahre (fiscalYearId, Beginn/Ende, Kontenrahmen).
   * @remarks Es werden bis zu 12 Jahre mit Details angereichert; schlägt eine
   *   Detailabfrage fehl, bleibt zumindest die `fiscalYearId` erhalten.
   */
  async listFiscalYears(input: {
    clientId: string;
  }): Promise<Record<string, unknown>> {
    const base = this.config.accountingDataExchangeBaseUrl;
    // Dynamische Pfadsegmente URL-kodieren (Defense-in-depth; clientId ist am
    // Tool-Eingang bereits als Beraternr-Mandantennr validiert).
    const clientSeg = encodeURIComponent(input.clientId);
    const { items: fiscalYearIds } = await this.http.getNdjson<number>(
      base,
      `/clients/${clientSeg}/fiscal-years`
    );

    // Details (Beginn/Ende/Kontenrahmen) nur für die ersten Jahre anreichern —
    // je Jahr ein zusätzlicher Aufruf. Die übrigen Jahre werden trotzdem
    // aufgeführt (nur mit fiscalYearId), damit kein Jahr unauffindbar wird.
    const DETAIL_LIMIT = 12;
    const enriched = await Promise.all(
      fiscalYearIds.slice(0, DETAIL_LIMIT).map(async (fiscalYearId) => {
        try {
          const detail = await this.http.getJson<FiscalYearDetails>(
            base,
            `/clients/${clientSeg}/fiscal-years/${encodeURIComponent(String(fiscalYearId))}`
          );
          return {
            fiscalYearId,
            beginn: detail.yearBegin?.slice(0, 10),
            ende: detail.yearEnd?.slice(0, 10),
            kontenrahmen:
              detail.accountSystem !== undefined
                ? `SKR${detail.accountSystem}`
                : undefined,
            sachkontenlaenge: detail.accountLength,
            waehrung: detail.currencyCode,
          };
        } catch {
          return { fiscalYearId };
        }
      })
    );
    const remaining = fiscalYearIds
      .slice(DETAIL_LIMIT)
      .map((fiscalYearId) => ({ fiscalYearId }));
    const details = [...enriched, ...remaining];

    return {
      wirtschaftsjahre: details,
      hinweis:
        remaining.length > 0
          ? `Die fiscalYearId für datev_load_from_cloud und datev_get_sums_and_balances verwenden. Details wurden nur für die ${DETAIL_LIMIT} neuesten Jahre geladen; die weiteren Jahre sind mit ihrer fiscalYearId gelistet.`
          : 'Die fiscalYearId für datev_load_from_cloud und datev_get_sums_and_balances verwenden.',
    };
  }

  /**
   * `datev_load_from_cloud`: lädt alle Buchungen eines Wirtschaftsjahres.
   *
   * Startet bzw. setzt den DATEV-Job fort, mappt die Buchungen ins gemeinsame
   * Modell und legt sie als aktiven Datensatz ab. Danach beantworten die
   * Analyse-Tools Fragen auf diesen Live-Daten.
   *
   * @param input - Mandant und Wirtschaftsjahr.
   * @returns Bei laufendem Job `status: in_arbeit` mit Hinweis, sonst
   *   `status: geladen` mit Buchungsanzahl und Kürzungsinfo.
   */
  async loadFromCloud(input: {
    clientId: string;
    fiscalYearId: number;
  }): Promise<Record<string, unknown>> {
    const result = await this.jobs.run(input.clientId, input.fiscalYearId);

    if (result.status === 'running') {
      return {
        status: 'in_arbeit',
        jobId: result.jobId,
        hinweis: result.hint,
      };
    }

    const clientSeg = encodeURIComponent(input.clientId);
    const fiscalYearSeg = encodeURIComponent(String(input.fiscalYearId));
    let clientName: string | undefined;
    let fiscalYear: FiscalYearDetails | undefined;
    try {
      const client = await this.http.getJson<CloudClient>(
        this.config.accountingClientsBaseUrl,
        `/clients/${clientSeg}`
      );
      clientName = client.name;
    } catch {
      // Name ist nur Komfort — Laden nicht daran scheitern lassen.
    }
    try {
      fiscalYear = await this.http.getJson<FiscalYearDetails>(
        this.config.accountingDataExchangeBaseUrl,
        `/clients/${clientSeg}/fiscal-years/${fiscalYearSeg}`
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
        'Die Buchungen sind jetzt geladen. Fragen können mit get_account_balance, get_open_items, list_bookings und search_documents beantwortet werden.',
    };
  }

  /**
   * `datev_get_sums_and_balances`: Summen-/Saldenliste direkt aus der Cloud.
   *
   * @param input - Mandant, Wirtschaftsjahr und optionale Konto-/Monatsfilter.
   * @returns Gesamt- und angezeigte Anzahl sowie die (auf {@link MAX_RESULT_ROWS}
   *   begrenzten) Kontozeilen; bei Kürzung mit Hinweis zum Eingrenzen.
   * @remarks Die API liefert alle Konten ohne serverseitigen Filter — die
   *   Einschränkung nach Kontonummer/Monat erfolgt daher hier im Server.
   */
  async getSumsAndBalances(input: {
    clientId: string;
    fiscalYearId: number;
    accountFrom?: number;
    accountTo?: number;
    accounts?: number[];
    month?: number;
  }): Promise<Record<string, unknown>> {
    let items: SumsAndBalancesEntry[];
    try {
      ({ items } = await this.http.getNdjson<SumsAndBalancesEntry>(
        this.config.accountingDataExchangeBaseUrl,
        `/clients/${encodeURIComponent(input.clientId)}/fiscal-years/${encodeURIComponent(String(input.fiscalYearId))}/sums-and-balances`
      ));
    } catch (error) {
      // Zeitüberschreitung: keine kryptische Fehlermeldung, sondern der Weg über
      // den Async-Job zu denselben Daten. Andere Fehler (401/403 …) unverändert
      // durchreichen, damit ihre spezifische Anleitung erhalten bleibt.
      if (isTimeoutError(error)) {
        return { status: 'zeitüberschreitung', hinweis: SUSA_TIMEOUT_HINWEIS };
      }
      throw error;
    }

    // DATEV liefert die Kontonummern technisch (Anzeigenummer + Auffüll-Nullen).
    // Padding aus den Daten ermitteln und für Filter und Ausgabe auf die
    // Anzeigenummer zurückrechnen, sonst trifft z. B. accountFrom/accountTo
    // (1000–1999) die 8-stelligen Rohnummern nie.
    const padding = detectAccountPadding(items.map((e) => e.accountNumber));
    const displayAccount = (entry: SumsAndBalancesEntry): number | undefined =>
      entry.accountNumber !== undefined
        ? Number(datevAccountToDisplay(entry.accountNumber, padding))
        : undefined;

    const accountSet = input.accounts ? new Set(input.accounts) : undefined;
    const filtered = items.filter((entry) => {
      const account = displayAccount(entry) ?? -1;
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
      konto: displayAccount(entry),
      bezeichnung: entry.caption,
      saldo: entry.balance,
      sollHaben: entry.balanceDebitCreditIdentifier,
      jahreswertSoll: entry.annualValueDebit,
      jahreswertHaben: entry.annualValueCredit,
      ebWertSoll: entry.openingBalanceDebit,
      ebWertHaben: entry.openingBalanceCredit,
      ...(input.month !== undefined
        ? (() => {
            const monthValue = entry.sumsAndBalancesMonthValues?.find(
              (value) => value.fiscalYearMonth === input.month
            );
            return {
              monat: input.month,
              monatssaldo: monthValue?.monthlyBalance,
              // Vorzeichen-Kennzeichen des Monatswerts mitgeben (analog zum
              // Jahreswert), sonst ist ein Habensaldo nicht von einem Sollsaldo
              // unterscheidbar.
              monatsSollHaben: monthValue?.monthlyBalanceDebitCreditIdentifier,
            };
          })()
        : {}),
    }));

    return {
      gesamtAnzahl: filtered.length,
      angezeigt: rows.length,
      ...(filtered.length > rows.length
        ? {
            hinweis:
              'Ausgabe gekürzt — bitte über Kontonummern-Filter eingrenzen.',
          }
        : {}),
      salden: rows,
    };
  }

  /**
   * `get_account_balance` (Cloud): autoritativer Kontosaldo aus DATEV.
   *
   * @param input - Kontonummer (Kurzform „1200" oder technisch „12000000").
   * @returns Für Cloud-Datensätze DATEVs eigenen Saldo (identisch zum
   *   DATEV-Kontoblatt) samt Verprobung gegen eine deterministische
   *   Kontrollrechnung aus den geladenen Buchungen; für Datei-Datensätze den aus
   *   dem Stapel gerechneten Saldo.
   * @remarks Der Saldo wird NIE im Sprachmodell aufsummiert — die verbindliche
   *   Zahl kommt aus DATEVs Summen-/Saldenliste, die Kontrolle aus dem Code.
   */
  async accountBalance(input: {
    account: string;
  }): Promise<Record<string, unknown>> {
    const dataset = datevStore.get();

    // Datei-Datensatz: exakte Rechnung aus dem Stapel (verbindlich, da keine
    // DATEV-Summenliste vorliegt). Exakter Konto-Vergleich verhindert die
    // Verwechslung benachbarter Konten (z. B. Sachkonto 1200 vs. Debitor 12000).
    if (!dataset.filePath.startsWith(CLOUD_PREFIX)) {
      const datei = computeAccountBalance(dataset.bookings, input.account);
      // Kein Treffer: kein irreführender Saldo 0, sondern klar „nicht gefunden".
      // (Die Kontonummer muss exakt zur Schreibweise im Stapel passen — Kurzform
      // 1200 vs. technisch 12000000.)
      if (datei.bookingCount === 0) {
        return {
          konto: input.account,
          gefunden: false,
          hinweis:
            'Kein Konto mit dieser Nummer im geladenen Buchungsstapel gefunden. Bitte die Kontonummer und ihre Schreibweise prüfen (Kurzform wie 1200 oder technisches Format wie 12000000); Überblick mit list_bookings.',
        };
      }
      return {
        konto: input.account,
        saldo: round2(datei.balance),
        sollHaben: datei.balance >= 0 ? 'S' : 'H',
        anzahlBuchungen: datei.bookingCount,
        letztesBuchungsdatum: datei.lastBookingDate,
        quelle: 'aus geladenem Buchungsstapel gerechnet (Datei-Import)',
      };
    }

    // Cloud-Kontrollrechnung: exakter Konto-Vergleich. Die Buchungen sind bereits
    // auf die Anzeigenummer normalisiert (siehe mapper), daher trifft „1200"
    // genau das Sachkonto 1200 und nicht den Debitor 12000. Verbindlich bleibt
    // der autoritative DATEV-Saldo aus der Summen-/Saldenliste weiter unten.
    const stapel = computeAccountBalance(dataset.bookings, input.account);
    const stapelOhneEB = computeAccountBalance(
      dataset.bookings,
      input.account,
      { excludeOpeningBalance: true }
    );

    // Cloud: clientId + fiscalYearId aus datev-cloud://<clientId>/<fiscalYearId>.
    const rest = dataset.filePath.slice(CLOUD_PREFIX.length);
    const slash = rest.lastIndexOf('/');
    const clientId = rest.slice(0, slash);
    const fiscalYearId = Number.parseInt(rest.slice(slash + 1), 10);

    let items: SumsAndBalancesEntry[];
    try {
      ({ items } = await this.http.getNdjson<SumsAndBalancesEntry>(
        this.config.accountingDataExchangeBaseUrl,
        `/clients/${encodeURIComponent(clientId)}/fiscal-years/${encodeURIComponent(String(fiscalYearId))}/sums-and-balances`
      ));
    } catch (error) {
      // Kommt DATEVs autoritative Zahl nicht rechtzeitig, geben wir bewusst
      // KEINEN `saldo` aus (nichts Verbindliches vorhanden), aber die
      // deterministische Kontrollrechnung als klar gekennzeichnete Nebeninfo
      // plus den Hinweis, es über den Async-Job erneut zu versuchen.
      if (isTimeoutError(error)) {
        return {
          konto: input.account,
          status: 'zeitüberschreitung',
          hinweis: SUSA_TIMEOUT_HINWEIS,
          kontrolleAusBuchungen: round2(stapel.balance),
          anzahlBuchungen: stapel.bookingCount,
        };
      }
      throw error;
    }

    // Der verbindliche Eintrag wird per EXAKTER Anzeigenummer gewählt: DATEVs
    // Rohnummer (z. B. 12000000) wird über das aus den Daten ermittelte Padding
    // auf die Anzeigeform zurückgerechnet und mit der Nutzereingabe verglichen.
    // Das ist eindeutig — 1200 und Debitor 12000 fallen NICHT zusammen.
    const padding = detectAccountPadding(items.map((c) => c.accountNumber));
    const query = input.account.trim();
    const entry = items.find(
      (candidate) =>
        candidate.accountNumber !== undefined &&
        datevAccountToDisplay(candidate.accountNumber, padding) === query
    );

    if (!entry) {
      return {
        konto: input.account,
        gefunden: false,
        hinweis:
          'Konto in DATEVs Summen-/Saldenliste nicht gefunden. Die Kontonummer muss exakt übereinstimmen (Kurzform wie in der Summen-/Saldenliste, z. B. 1200). Überblick mit datev_get_sums_and_balances.',
        kontrolleAusBuchungen: {
          saldo: round2(stapel.balance),
          anzahlBuchungen: stapel.bookingCount,
        },
      };
    }

    // DATEVs autoritativer Saldo mit Vorzeichen (Haben => negativ).
    const datevBetrag = entry.balance ?? 0;
    const datevSaldo =
      entry.balanceDebitCreditIdentifier === 'H' ? -datevBetrag : datevBetrag;

    // Verprobung: Die EB-Behandlung darf sich definitionsbedingt unterscheiden,
    // daher gilt Übereinstimmung, wenn die Kontrolle MIT oder OHNE EB passt.
    const toleranz = 0.01;
    const stimmtMitDatevUeberein =
      Math.abs(datevSaldo - stapel.balance) <= toleranz ||
      Math.abs(datevSaldo - stapelOhneEB.balance) <= toleranz;

    return {
      konto:
        entry.accountNumber !== undefined
          ? Number(datevAccountToDisplay(entry.accountNumber, padding))
          : entry.accountNumber,
      bezeichnung: entry.caption ?? null,
      saldo: round2(datevSaldo),
      sollHaben:
        entry.balanceDebitCreditIdentifier ?? (datevSaldo >= 0 ? 'S' : 'H'),
      quelle:
        'DATEV Summen-/Saldenliste (autoritativ, entspricht dem DATEV-Kontoblatt)',
      jahreswertSoll: entry.annualValueDebit,
      jahreswertHaben: entry.annualValueCredit,
      ebWertSoll: entry.openingBalanceDebit,
      ebWertHaben: entry.openingBalanceCredit,
      letztesBuchungsdatum: stapel.lastBookingDate,
      verprobung: {
        stimmtMitDatevUeberein,
        kontrolleAusBuchungen: round2(stapel.balance),
        kontrolleOhneEB: round2(stapelOhneEB.balance),
        anzahlBuchungen: stapel.bookingCount,
        ...(stimmtMitDatevUeberein
          ? {}
          : {
              warnung:
                'ACHTUNG: Kontrollrechnung aus den Buchungen weicht vom DATEV-Saldo ab. Verbindlich ist der DATEV-Saldo oben; Abweichung prüfen (z. B. unvollständig geladene Buchungen oder Konto-Verwechslung).',
            }),
      },
      hinweis:
        'Verbindlich ist das Feld "saldo" (DATEV). Diese Zahl wörtlich übernehmen und NICHT selbst aus Buchungen neu berechnen.',
    };
  }
}

/** Typprüfung, ob ein Fehler eine fehlende Anmeldung signalisiert. */
export const isNotLoggedInError = (error: unknown): boolean =>
  error instanceof NotLoggedInError;
