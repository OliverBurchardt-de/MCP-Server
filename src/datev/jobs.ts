import type { DatevConfig } from '../config.js';
import type { DatevHttpClient } from './http.js';
import type { AccountPosting } from './types.js';

/** Zeitbudget pro Tool-Aufruf — bleibt unter üblichen MCP-Client-Timeouts. */
const DEFAULT_BUDGET_MS = 45_000;
const POLL_DELAYS_MS = [1000, 2000, 3000, 5000];
const MAX_ROWS = 50_000;

type JobState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DELETED';

export type JobResult =
  | { status: 'completed'; postings: AccountPosting[]; totalCount: number; truncated: boolean }
  | { status: 'running'; jobId: string; hint: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AccountPostingsJobRunner {
  /** Laufende Jobs je Mandant+Wirtschaftsjahr, damit ein erneuter Aufruf denselben Job fortsetzt. */
  private readonly pendingJobs = new Map<string, string>();

  constructor(
    private readonly config: DatevConfig,
    private readonly http: DatevHttpClient
  ) {}

  async run(
    clientId: string,
    fiscalYearId: number,
    budgetMs: number = DEFAULT_BUDGET_MS
  ): Promise<JobResult> {
    const key = `${clientId}:${fiscalYearId}`;
    const base = this.config.accountingDataExchangeBaseUrl;
    const deadline = Date.now() + budgetMs;

    let jobId = this.pendingJobs.get(key);
    if (!jobId) {
      const response = await this.http.request(
        base,
        `/clients/${clientId}/fiscal-years/${fiscalYearId}/account-postings`,
        { method: 'POST' }
      );
      jobId = (JSON.parse(response.text) as { jobId: string }).jobId;
      this.pendingJobs.set(key, jobId);
    }

    let delayIndex = 0;
    for (;;) {
      const state = await this.http.getJson<{ jobState: JobState }>(
        base,
        `/clients/${clientId}/jobs/${jobId}/state`
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

      const delay = POLL_DELAYS_MS[Math.min(delayIndex, POLL_DELAYS_MS.length - 1)] ?? 5000;
      delayIndex += 1;
      if (Date.now() + delay > deadline) {
        return {
          status: 'running',
          jobId,
          hint: 'DATEV bereitet die Buchungsdaten noch auf. Bitte dieselbe Anfrage in etwa 30 Sekunden wiederholen — der laufende Auftrag wird dann fortgesetzt.'
        };
      }
      await sleep(delay);
    }

    const postings: AccountPosting[] = [];
    let totalCount = 0;
    let page = 1;
    let totalPages = 1;

    do {
      const { items, headers } = await this.http.getNdjson<AccountPosting>(
        base,
        `/clients/${clientId}/account-postings-jobs/${jobId}`,
        { page }
      );
      postings.push(...items);
      totalPages = Number.parseInt(headers.get('x-total-pages') ?? '1', 10) || 1;
      totalCount = Number.parseInt(headers.get('x-total-count') ?? '', 10) || postings.length;
      page += 1;
    } while (page <= totalPages && postings.length < MAX_ROWS);

    this.pendingJobs.delete(key);

    return {
      status: 'completed',
      postings: postings.slice(0, MAX_ROWS),
      totalCount,
      truncated: totalCount > MAX_ROWS
    };
  }
}
