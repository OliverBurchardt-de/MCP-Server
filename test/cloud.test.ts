import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type DatevConfig } from '../src/config.js';
import type { FetchLike } from '../src/auth/oauth.js';
import { FileTokenStore } from '../src/auth/token-store.js';
import { NotLoggedInError, TokenManager } from '../src/auth/token-manager.js';
import { datevErrorFromResponse } from '../src/datev/errors.js';
import { DatevHttpClient, parseNdjson } from '../src/datev/http.js';
import { AccountPostingsJobRunner } from '../src/datev/jobs.js';
import { buildCloudDataset, mapAccountPosting } from '../src/datev/mapper.js';
import { accountMatches } from '../src/tools/balance.js';
import { CloudTools } from '../src/tools/cloud.js';
import { datevStore } from '../src/store/memory.js';

const makeConfig = (overrides: Partial<DatevConfig> = {}): DatevConfig => ({
  ...loadConfig({
    DATEV_ENV: 'sandbox',
    DATEV_CLIENT_ID: 'test-client-id',
    DATEV_CLIENT_SECRET: 'test-secret',
    DATEV_TOKEN_STORE: path.join(tempDir, 'tokens.json'),
  }),
  ...overrides,
});

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-mcp-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const storeValidTokens = (
  config: DatevConfig,
  expiresInMs = 3_600_000
): void => {
  new FileTokenStore(config.tokenStorePath).save({
    accessToken: 'valid-access-token',
    refreshToken: 'valid-refresh-token',
    expiresAt: Date.now() + expiresInMs,
  });
};

describe('FileTokenStore', () => {
  it('persists and restores tokens with restrictive permissions', () => {
    const filePath = path.join(tempDir, 'nested', 'tokens.json');
    const store = new FileTokenStore(filePath);
    store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });

    expect(store.load()).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    store.clear();
    expect(store.load()).toBeUndefined();
  });
});

describe('TokenManager', () => {
  it('throws a German login hint when no tokens exist', async () => {
    const config = makeConfig();
    const manager = new TokenManager(config);

    await expect(manager.getAccessToken()).rejects.toThrow(NotLoggedInError);
    await expect(manager.getAccessToken()).rejects.toThrow(/datev_login/);
  });

  it('returns the stored token while it is still valid', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi.fn();
    const manager = new TokenManager(config, fetchMock as unknown as FetchLike);

    await expect(manager.getAccessToken()).resolves.toBe('valid-access-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token, persists rotation and single-flights parallel calls', async () => {
    const config = makeConfig();
    new FileTokenStore(config.tokenStorePath).save({
      accessToken: 'expired',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1000,
    });

    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      })
    );
    const manager = new TokenManager(config, fetchMock as unknown as FetchLike);

    const [first, second] = await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    expect(first).toBe('fresh-access');
    expect(second).toBe('fresh-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = new FileTokenStore(config.tokenStorePath).load();
    expect(persisted?.refreshToken).toBe('rotated-refresh');

    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain('grant_type=refresh_token');
    expect((init?.headers as Record<string, string>).Authorization).toMatch(
      /^Basic /
    );
  });
});

describe('datevErrorFromResponse', () => {
  it('maps common statuses to German guidance', () => {
    expect(datevErrorFromResponse(401, '').message).toContain('datev_login');
    expect(datevErrorFromResponse(403, '').message).toContain('freigeschaltet');
    expect(datevErrorFromResponse(429, '').message).toContain('Ratenlimit');
  });

  it('includes ProblemDetail title and detail', () => {
    const error = datevErrorFromResponse(
      404,
      JSON.stringify({
        title: 'Not Found',
        detail: 'Client unknown',
        requestId: 'req-1',
      })
    );
    expect(error.message).toContain('Not Found — Client unknown');
    expect(error.requestId).toBe('req-1');
  });
});

describe('parseNdjson', () => {
  it('parses newline-delimited JSON and JSON arrays alike', () => {
    expect(parseNdjson('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseNdjson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseNdjson('  ')).toEqual([]);
  });
});

describe('DatevHttpClient', () => {
  it('sends Bearer token plus X-DATEV-Client-Id header', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse([{ id: '455148-1' }])
    );
    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );

    await client.getJson(config.accountingClientsBaseUrl, '/clients', {
      top: 5,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      'https://accounting-clients.api.datev.de/platform-sandbox/v2/clients?top=5'
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer valid-access-token');
    expect(headers['X-DATEV-Client-Id']).toBe('test-client-id');
  });

  it('retries on 429 with Retry-After and then succeeds', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse('', { status: 429, headers: { 'retry-after': '0' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );

    await expect(
      client.getJson(config.accountingClientsBaseUrl, '/clients')
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AccountPostingsJobRunner', () => {
  const posting = { accountNumber: 1200, amountDebit: 100, date: '2026-01-15' };

  it('submits a job, polls until COMPLETED and fetches all pages', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi
      .fn()
      // POST account-postings
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, { status: 202 }))
      // Poll: PENDING → COMPLETED
      .mockResolvedValueOnce(jsonResponse({ jobState: 'PENDING' }))
      .mockResolvedValueOnce(jsonResponse({ jobState: 'COMPLETED' }))
      // Ergebnisseiten
      .mockResolvedValueOnce(
        jsonResponse(`${JSON.stringify(posting)}\n`, {
          headers: { 'x-total-pages': '2', 'x-total-count': '2' },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          `${JSON.stringify({ ...posting, accountNumber: 4930 })}\n`,
          {
            headers: { 'x-total-pages': '2', 'x-total-count': '2' },
          }
        )
      );

    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );
    const runner = new AccountPostingsJobRunner(config, client);

    const result = await runner.run('455148-1', 20260101);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.postings).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.truncated).toBe(false);
    }
  });

  it('returns "running" when the budget is exhausted and resumes the same job afterwards', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    let calls = 0;
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ jobId: 'job-slow' }, { status: 202 })
        : jsonResponse({ jobState: 'PENDING' });
    });

    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );
    const runner = new AccountPostingsJobRunner(config, client);

    // Budget 0 → sofortiger Timeout nach der ersten Statusabfrage.
    const first = await runner.run('455148-1', 20260101, 0);
    expect(first.status).toBe('running');
    if (first.status === 'running') {
      expect(first.jobId).toBe('job-slow');
      expect(first.hint).toContain('30 Sekunden');
    }

    const countPostCalls = (): number =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;

    const postCallsBefore = countPostCalls();

    const second = await runner.run('455148-1', 20260101, 0);
    expect(second.status).toBe('running');

    const postCallsAfter = countPostCalls();
    // Kein zweiter POST — derselbe Job wird fortgesetzt.
    expect(postCallsAfter).toBe(postCallsBefore);
  });

  it('fails with a German message when the job state is FAILED', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ jobId: 'job-bad' }, { status: 202 })
      )
      .mockResolvedValueOnce(jsonResponse({ jobState: 'FAILED' }));

    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );
    const runner = new AccountPostingsJobRunner(config, client);

    await expect(runner.run('455148-1', 20260101)).rejects.toThrow(
      /fehlgeschlagen/
    );
  });
});

describe('mapper', () => {
  it('maps debit and credit postings to DatevBooking directions', () => {
    const debit = mapAccountPosting(
      {
        accountNumber: 4930,
        contraAccountNumber: 1200,
        amountDebit: 89.5,
        date: '2026-01-05',
        postingDescription: 'Büromaterial',
        documentField1: 'BM-1001',
        currencyCode: 'EUR',
      },
      0
    );
    expect(debit.direction).toBe('S');
    expect(debit.amount).toBe(89.5);
    expect(debit.account).toBe('4930');
    expect(debit.bookingDate).toBe('2026-01-05');

    const credit = mapAccountPosting(
      { accountNumber: 8400, amountCredit: 500 },
      1
    );
    expect(credit.direction).toBe('H');
    expect(credit.amount).toBe(500);
  });

  it('builds a cloud dataset with header metadata from the fiscal year', () => {
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20260101,
      {
        yearBegin: '2026-01-01',
        yearEnd: '2026-12-31',
        accountLength: 4,
        accountSystem: '03',
      },
      [{ accountNumber: 1200, amountDebit: 1, date: '2026-01-02' }]
    );

    expect(dataset.header.advisorNumber).toBe('455148');
    expect(dataset.header.clientNumber).toBe('1');
    expect(dataset.header.clientName).toBe('Testmandant');
    expect(dataset.header.accountFramework).toBe('SKR03');
    expect(dataset.header.dateFrom).toBe('2026-01-01');
    expect(dataset.bookings).toHaveLength(1);
    expect(dataset.filePath).toBe('datev-cloud://455148-1/20260101');
  });
});

describe('accountMatches', () => {
  it('matches identical numbers and the technical (zero-padded) form', () => {
    expect(accountMatches('1200', '1200')).toBe(true);
    // Kurzform "1200" trifft die technische Form "12000000".
    expect(accountMatches('1200', '12000000')).toBe(true);
    expect(accountMatches('12000000', '1200')).toBe(true);
    // Debitor 60105 -> technisch 60105000.
    expect(accountMatches('60105', '60105000')).toBe(true);
  });

  it('does not match different accounts', () => {
    expect(accountMatches('1200', '1230')).toBe(false);
    expect(accountMatches('1200', '8400')).toBe(false);
    expect(accountMatches('1200', '12010000')).toBe(false);
  });
});

describe('CloudTools.accountBalance', () => {
  // Zwei SuSa-Konten als NDJSON; 1200 mit Habensaldo 70.836,64 (wie DATEV).
  const susaNdjson = [
    JSON.stringify({
      accountNumber: 1200,
      caption: 'Bank',
      balance: 70836.64,
      balanceDebitCreditIdentifier: 'H',
      annualValueDebit: 1567893.27,
      annualValueCredit: 1638729.91,
      openingBalanceCredit: 76285.93,
    }),
    JSON.stringify({
      accountNumber: 1400,
      caption: 'Forderungen',
      balance: 170307.03,
      balanceDebitCreditIdentifier: 'S',
    }),
  ].join('\n');

  afterEach(() => {
    datevStore.clear();
  });

  const loadCloudDataset = (postings: Array<Record<string, unknown>>): void => {
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20230101,
      { accountLength: 4, accountSystem: '03' },
      postings
    );
    datevStore.set(dataset, '455148-1:20230101');
  };

  it('returns DATEVs authoritative balance and confirms the reconciliation', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    // Buchung, die den DATEV-Saldo exakt nachbildet (technische Kontonummer).
    loadCloudDataset([
      { accountNumber: 12000000, amountCredit: 70836.64, date: '2023-12-31' },
    ]);

    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susaNdjson)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });

    expect(result.konto).toBe(1200);
    expect(result.saldo).toBe(-70836.64);
    expect(result.sollHaben).toBe('H');
    expect(String(result.quelle)).toContain('autoritativ');
    expect(
      (result.verprobung as Record<string, unknown>).stimmtMitDatevUeberein
    ).toBe(true);
  });

  it('flags a warning when the postings-based control differs grossly', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    // Absichtlich falsche Buchungssumme -> Verprobung muss anschlagen.
    loadCloudDataset([
      { accountNumber: 12000000, amountCredit: 1025389.28, date: '2023-12-31' },
    ]);

    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susaNdjson)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });
    const verprobung = result.verprobung as Record<string, unknown>;

    // Verbindlich bleibt DATEVs Saldo; die Kontrolle weicht ab und warnt.
    expect(result.saldo).toBe(-70836.64);
    expect(verprobung.stimmtMitDatevUeberein).toBe(false);
    expect(String(verprobung.warnung)).toContain('ACHTUNG');
  });
});
