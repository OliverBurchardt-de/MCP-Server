/**
 * Führt das asynchrone DATEV-Auftragsmuster für Buchungssätze aus.
 *
 * Buchungsdaten werden bei DATEV nicht direkt geliefert: Man stößt einen Job an
 * (POST), fragt dessen Status (Poll) und lädt am Ende die Ergebnisseiten. Der
 * Job liefert immer das komplette Wirtschaftsjahr — deshalb Zeilen-Cap und
 * clientseitige Filterung in den aufrufenden Tools.
 *
 * @remarks
 * Weil MCP-Tool-Aufrufe ein Zeitbudget haben, wartet dieser Runner nur begrenzt
 * ({@link DEFAULT_BUDGET_MS}). Läuft der Job länger, meldet er `running` samt
 * `jobId`; ein erneuter Aufruf setzt denselben Job fort, statt einen neuen zu
 * starten (siehe {@link AccountPostingsJobRunner.pendingJobs}).
 */
import type { DatevConfig } from '../config.js';
import type { DatevHttpClient } from './http.js';
import type { AccountPosting } from './types.js';

/** Zeitbudget pro Tool-Aufruf — bleibt unter üblichen MCP-Client-Timeouts. */
const DEFAULT_BUDGET_MS = 45_000;
/** Wartezeiten zwischen Statusabfragen; der letzte Wert wird wiederholt. */
const POLL_DELAYS_MS = [1000, 2000, 3000, 5000];
/** Obergrenze geladener Buchungszeilen, um Speicher/Kontext zu schützen. */
const MAX_ROWS = 50_000;

/** Möglicher Bearbeitungsstand eines DATEV-Jobs. */
type JobState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DELETED';

/** Ergebnis eines Job-Laufs: fertig (mit Daten) oder noch in Arbeit. */
export type JobResult =
  | {
      status: 'completed';
      postings: AccountPosting[];
      totalCount: number;
      truncated: boolean;
    }
  | { status: 'running'; jobId: string; hint: string };

/** Kleine Verzögerungshilfe für die Poll-Wartezeit. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Startet, überwacht und liest DATEV-Buchungssatz-Jobs (account-postings). */
export class AccountPostingsJobRunner {
  /**
   * Laufende Jobs je `clientId:fiscalYearId`.
   *
   * @remarks Ermöglicht, dass ein wiederholter Aufruf nach einem Timeout
   *   denselben Job fortsetzt, statt einen neuen anzustoßen.
   */
  private readonly pendingJobs = new Map<string, string>();

  /**
   * @param config - Aktive Konfiguration (liefert die ADE-Basis-URL).
   * @param http - HTTP-Client für die eigentlichen Aufrufe.
   */
  constructor(
    private readonly config: DatevConfig,
    private readonly http: DatevHttpClient
  ) {}

  /**
   * Führt den Job aus: anstoßen bzw. fortsetzen, pollen, Ergebnisseiten laden.
   *
   * @param clientId - Mandant im Format `Beraternummer-Mandantennummer`.
   * @param fiscalYearId - Wirtschaftsjahr als Zahl `JJJJMMTT`.
   * @param budgetMs - Maximale Wartezeit; Standard {@link DEFAULT_BUDGET_MS}.
   *   In Tests wird `0` genutzt, um den Timeout-Pfad sofort auszulösen.
   * @returns `completed` mit Buchungen (evtl. gekürzt) oder `running` mit `jobId`
   *   und einem Hinweis, die Anfrage später zu wiederholen.
   * @throws Error - wenn DATEV den Job mit `FAILED`/`DELETED` beendet.
   */
  async run(
    clientId: string,
    fiscalYearId: number,
    budgetMs: number = DEFAULT_BUDGET_MS
  ): Promise<JobResult> {
    const key = `${clientId}:${fiscalYearId}`;
    const base = this.config.accountingDataExchangeBaseUrl;
    const deadline = Date.now() + budgetMs;

    // Dynamische Pfadsegmente URL-kodieren (Defense-in-depth; clientId/
    // fiscalYearId sind bereits am Tool-Eingang validiert, jobId stammt aus der API).
    const clientSeg = encodeURIComponent(clientId);
    const fiscalYearSeg = encodeURIComponent(String(fiscalYearId));

    let jobId = this.pendingJobs.get(key);
    if (!jobId) {
      const response = await this.http.request(
        base,
        `/clients/${clientSeg}/fiscal-years/${fiscalYearSeg}/account-postings`,
        { method: 'POST' }
      );
      jobId = (JSON.parse(response.text) as { jobId: string }).jobId;
      this.pendingJobs.set(key, jobId);
    }
    const jobSeg = encodeURIComponent(jobId);

    // Statusabfrage mit wachsender Wartezeit, bis der Job fertig ist oder das
    // Zeitbudget erschöpft ist.
    let delayIndex = 0;
    for (;;) {
      const state = await this.http.getJson<{ jobState: JobState }>(
        base,
        `/clients/${clientSeg}/jobs/${jobSeg}/state`
      );

      if (state.jobState === 'COMPLETED') {
        break;
      }

      if (state.jobState === 'FAILED' || state.jobState === 'DELETED') {
        this.pendingJobs.delete(key);
        throw new Error(
          `Der DATEV-Auftrag zur Aufbereitung der Buchungsdaten ist fehlgeschlagen (Status ${state.jobState}). Bitte erneut versuchen.`
        );
      }

      const delay =
        POLL_DELAYS_MS[Math.min(delayIndex, POLL_DELAYS_MS.length - 1)] ?? 5000;
      delayIndex += 1;
      if (Date.now() + delay > deadline) {
        return {
          status: 'running',
          jobId,
          hint: 'DATEV bereitet die Buchungsdaten noch auf. Bitte dieselbe Anfrage in etwa 30 Sekunden wiederholen — der laufende Auftrag wird dann fortgesetzt.',
        };
      }
      await sleep(delay);
    }

    // Fertig: alle Ergebnisseiten sequenziell laden. `x-total-pages` steuert
    // das Ende; der Zeilen-Cap bricht bei sehr großen Beständen vorzeitig ab.
    const postings: AccountPosting[] = [];
    let totalCount = 0;
    let page = 1;
    let totalPages = 1;

    do {
      const { items, headers } = await this.http.getNdjson<AccountPosting>(
        base,
        `/clients/${clientSeg}/account-postings-jobs/${jobSeg}`,
        { page }
      );
      // Einzeln anhängen und beim Zeilen-Cap stoppen — kein `push(...items)`
      // mit sehr großen Arrays (Stack-Risiko) und keine Übernahme über MAX_ROWS.
      for (const item of items) {
        if (postings.length >= MAX_ROWS) {
          break;
        }
        postings.push(item);
      }
      totalPages =
        Number.parseInt(headers.get('x-total-pages') ?? '1', 10) || 1;
      totalCount =
        Number.parseInt(headers.get('x-total-count') ?? '', 10) ||
        postings.length;
      page += 1;
    } while (page <= totalPages && postings.length < MAX_ROWS);

    this.pendingJobs.delete(key);

    return {
      status: 'completed',
      postings: postings.slice(0, MAX_ROWS),
      totalCount,
      truncated: totalCount > MAX_ROWS,
    };
  }
}
