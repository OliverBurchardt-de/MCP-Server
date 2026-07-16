import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type DatevConfig } from '../src/config.js';
import type { FetchLike } from '../src/auth/oauth.js';
import { escapeHtml } from '../src/auth/loopback.js';
import { FileTokenStore } from '../src/auth/token-store.js';
import { NotLoggedInError, TokenManager } from '../src/auth/token-manager.js';
import {
  datevAccountToDisplay,
  detectAccountPadding,
} from '../src/datev/account.js';
import { datevErrorFromResponse } from '../src/datev/errors.js';
import { DatevHttpClient, parseNdjson } from '../src/datev/http.js';
import { AccountPostingsJobRunner } from '../src/datev/jobs.js';
import { buildCloudDataset, mapAccountPosting } from '../src/datev/mapper.js';
import { accountMatches } from '../src/tools/balance.js';
import { listBookings } from '../src/tools/bookings.js';
import { CloudTools } from '../src/tools/cloud.js';
import { loadDatevFile } from '../src/tools/load.js';
import { getOpenItems } from '../src/tools/openItems.js';
import { searchDocuments } from '../src/tools/search.js';
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
    // POSIX-Dateirechte (0600) nur auf Unix/macOS prüfen. Windows kennt keine
    // POSIX-Bits (Node meldet dort 0666) und schützt die Datei stattdessen über
    // das Benutzerkonto — der Code setzt den Modus trotzdem plattformübergreifend.
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }

    store.clear();
    expect(store.load()).toBeUndefined();
  });

  it('writes atomically without leaving a temp file behind', () => {
    const filePath = path.join(tempDir, 'tokens.json');
    const store = new FileTokenStore(filePath);
    store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    // Zweites Speichern (Rotation) darf die gültige Datei nicht beschädigen.
    store.save({ accessToken: 'b', refreshToken: 'r2', expiresAt: 2 });

    expect(store.load()).toMatchObject({
      accessToken: 'b',
      refreshToken: 'r2',
    });
    const leftovers = fs
      .readdirSync(tempDir)
      .filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('escapeHtml', () => {
  it('neutralises HTML so reflected values cannot inject markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeHtml('a & "b" \'c\'')).toBe(
      'a &amp; &quot;b&quot; &#39;c&#39;'
    );
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

  it('skips a corrupt line instead of failing the whole load', () => {
    expect(parseNdjson('{"a":1}\n{broken\n{"a":2}')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    // Ein beschädigtes JSON-Array ergibt eine leere Liste statt eines Wurfs.
    expect(parseNdjson('[{"a":1},')).toEqual([]);
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

  it('clamps an excessive Retry-After to at most 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      storeValidTokens(config);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse('', {
            status: 503,
            headers: { 'retry-after': '86400' },
          })
        )
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = new DatevHttpClient(
        config,
        new TokenManager(config, fetchMock as unknown as FetchLike),
        fetchMock as unknown as FetchLike
      );

      const promise = client.getJson(
        config.accountingClientsBaseUrl,
        '/clients'
      );
      // 30 s reichen wegen des Deckels — ohne ihn müsste 86400 s gewartet werden.
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
      [{ accountNumber: 12000000, amountDebit: 1, date: '2026-01-02' }]
    );

    expect(dataset.header.advisorNumber).toBe('455148');
    expect(dataset.header.clientNumber).toBe('1');
    expect(dataset.header.clientName).toBe('Testmandant');
    expect(dataset.header.accountFramework).toBe('SKR03');
    expect(dataset.header.dateFrom).toBe('2026-01-01');
    expect(dataset.header.accountLength).toBe(4);
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
  // Zwei SuSa-Konten als NDJSON in technischer Form (Sachkontenlänge 4 → 8-stellig);
  // 1200 (roh 12000000) mit Habensaldo 70.836,64 (wie DATEV).
  const susaNdjson = [
    JSON.stringify({
      accountNumber: 12000000,
      caption: 'Bank',
      balance: 70836.64,
      balanceDebitCreditIdentifier: 'H',
      annualValueDebit: 1567893.27,
      annualValueCredit: 1638729.91,
      openingBalanceCredit: 76285.93,
    }),
    JSON.stringify({
      accountNumber: 14000000,
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

  it('selects the exact account, never a neighbouring padded one', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    loadCloudDataset([
      { accountNumber: 12000000, amountCredit: 70836.64, date: '2023-12-31' },
    ]);
    // Debitor 12000 (roh 120000000) steht ZUERST — eine tolerante Suche würde
    // ihn liefern. Sachkonto 1200 ist roh 12000000. Beide sind eindeutig.
    const mixedSusa = [
      JSON.stringify({
        accountNumber: 120000000,
        caption: 'Debitor Alpha',
        balance: 500,
        balanceDebitCreditIdentifier: 'S',
      }),
      JSON.stringify({
        accountNumber: 12000000,
        caption: 'Bank',
        balance: 70836.64,
        balanceDebitCreditIdentifier: 'H',
      }),
    ].join('\n');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(mixedSusa)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });

    expect(result.konto).toBe(1200);
    expect(result.saldo).toBe(-70836.64);
  });

  it('reports not found rather than returning a padded neighbour', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    loadCloudDataset([
      { accountNumber: 120000000, amountDebit: 500, date: '2023-05-01' },
    ]);
    const onlyDebitor = JSON.stringify({
      accountNumber: 120000000,
      caption: 'Debitor Alpha',
      balance: 500,
      balanceDebitCreditIdentifier: 'S',
    });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(onlyDebitor)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });

    expect(result.gefunden).toBe(false);
  });
});

describe('Externe Review-Fixes', () => {
  afterEach(() => {
    datevStore.clear();
  });

  const loadDs = (
    postings: Array<Record<string, unknown>>,
    key = 'k',
    accountLength = 4
  ): void => {
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20260101,
      { accountLength, accountSystem: '03' },
      postings
    );
    datevStore.set(dataset, key);
  };

  it('Fix 1: gibt beim Monatswert das Soll/Haben-Kennzeichen mit', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const susa = JSON.stringify({
      accountNumber: 84000000,
      caption: 'Erlöse',
      balance: 5000,
      balanceDebitCreditIdentifier: 'H',
      sumsAndBalancesMonthValues: [
        {
          fiscalYearMonth: 3,
          monthlyBalance: 1200,
          monthlyBalanceDebitCreditIdentifier: 'H',
        },
      ],
    });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susa)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.getSumsAndBalances({
      clientId: '455148-1',
      fiscalYearId: 20230101,
      month: 3,
    });
    const rows = result.salden as Array<Record<string, unknown>>;

    expect(rows[0]?.monatssaldo).toBe(1200);
    expect(rows[0]?.monatsSollHaben).toBe('H');
  });

  it('Fix 2: begrenzt list_bookings und search_documents auf 200', () => {
    const many = Array.from({ length: 250 }, () => ({
      accountNumber: 84000000,
      amountDebit: 1,
      date: '2026-01-02',
      postingDescription: 'Beleg',
    }));
    loadDs(many);

    const bookings = listBookings({});
    expect(bookings.count).toBe(250);
    expect(bookings.angezeigt).toBe(200);
    expect(bookings.items).toHaveLength(200);
    expect(String(bookings.hinweis)).toContain('gekürzt');

    const search = searchDocuments({ query: 'Beleg' });
    expect(search.count).toBe(250);
    expect(search.angezeigt).toBe(200);
  });

  it('Fix 3: erzeugt beide Personenkonto-Posten einer Umbuchung', () => {
    // Debitor 10000 (roh 100000000) und Kreditor 70000 (roh 700000000),
    // Sachkontenlänge 4.
    loadDs([
      {
        accountNumber: 100000000,
        contraAccountNumber: 700000000,
        amountDebit: 100,
        date: '2026-02-01',
      },
    ]);

    const result = getOpenItems({});
    expect(result.count).toBe(2);
    const debtor = result.items.find((item) => item.account === '10000');
    const creditor = result.items.find((item) => item.account === '70000');
    expect(debtor?.accountType).toBe('debtor');
    expect(debtor?.amount).toBeGreaterThan(0);
    expect(creditor?.accountType).toBe('creditor');
    expect(creditor?.amount).toBeLessThan(0);
  });

  it('Fix 4: listet auch Wirtschaftsjahre jenseits der ersten 12', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const years = Array.from(
      { length: 14 },
      (_, i) => (2024 - i) * 10000 + 101
    );
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
      const u = String(url);
      if (/\/fiscal-years\/\d+/.test(u)) {
        return jsonResponse({
          yearBegin: '2024-01-01',
          yearEnd: '2024-12-31',
          accountLength: 4,
          accountSystem: '03',
        });
      }
      return jsonResponse(years.map(String).join('\n'));
    });
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.listFiscalYears({ clientId: '455148-1' });
    const wj = result.wirtschaftsjahre as Array<Record<string, unknown>>;

    expect(wj).toHaveLength(14);
    // Das 14. (älteste) Jahr ist gelistet, wenn auch ohne Detailfelder.
    expect(wj[13]?.fiscalYearId).toBe(20110101);
    expect(String(result.hinweis)).toContain('Details wurden nur');
  });

  it('Fix 5: meldet im Datei-Modus ein unbekanntes Konto als gefunden:false', async () => {
    loadDatevFile(
      { path: path.resolve('test/fixtures/sample.extf') },
      path.resolve('test/fixtures')
    );
    const cloud = new CloudTools(makeConfig());

    const result = await cloud.accountBalance({ account: '99999999' });
    expect(result.gefunden).toBe(false);
    expect(result.saldo).toBeUndefined();
  });

  it('Fix 7: datumslose Buchung bleibt bei gesetztem from-Filter erhalten', () => {
    loadDs([
      { accountNumber: 84000000, amountDebit: 1, date: '2026-01-02' }, // vor from
      { accountNumber: 85000000, amountDebit: 2 }, // ohne Datum
    ]);

    const result = listBookings({ from: '2026-06-01' });
    expect(result.count).toBe(1);
    expect(result.items[0]?.account).toBe('8500');
  });
});

describe('Technisches Kontonummern-Format (Sachkontenlänge-abhängig)', () => {
  afterEach(() => {
    datevStore.clear();
  });

  it('detectAccountPadding erkennt das Padding bei Sachkontenlänge 4', () => {
    // 84010000 = Sachkonto 8401 (endet nicht auf 0) verrät das Padding 4.
    expect(detectAccountPadding([12000000, 104000000, 84010000])).toBe(4);
  });

  it('detectAccountPadding erkennt das Padding bei Sachkontenlänge 5 (Comtec)', () => {
    // Debitor 100005 -> 100005000 (endet auf genau 3 Nullen) verrät Padding 3.
    expect(detectAccountPadding([12000000, 100005000, 700000000])).toBe(3);
  });

  it('datevAccountToDisplay rechnet technische Rohnummern mit dem Padding zurück', () => {
    // Sachkontenlänge 4 (Padding 4)
    expect(datevAccountToDisplay(12000000, 4)).toBe('1200');
    expect(datevAccountToDisplay(104000000, 4)).toBe('10400');
    // Sachkontenlänge 5 (Padding 3) — dieselbe Rohnummer, andere Anzeige!
    expect(datevAccountToDisplay(12000000, 3)).toBe('12000');
    expect(datevAccountToDisplay(100005000, 3)).toBe('100005');
    expect(datevAccountToDisplay(700000000, 3)).toBe('700000');
    // Padding 0 lässt den Wert unverändert.
    expect(datevAccountToDisplay('1200', 0)).toBe('1200');
  });

  it('mapper normalisiert technische Buchungs-Kontonummern (mit Padding)', () => {
    const booking = mapAccountPosting(
      {
        accountNumber: 104000000,
        contraAccountNumber: 12000000,
        amountDebit: 100,
      },
      0,
      4
    );
    expect(booking.account).toBe('10400');
    expect(booking.contraAccount).toBe('1200');
  });

  it('erkennt bei Sachkontenlänge 5 (Comtec) die Personenkonten korrekt', () => {
    // Debitor 100005 (6-stellig) und Kreditor 700000 (6-stellig) — technisch mit
    // Padding 3. Ein Sachkonto (84010) mit Nicht-Null-Ende verrät das Padding.
    const dataset = buildCloudDataset(
      '13540',
      'Comtec GmbH',
      20250101,
      undefined,
      [
        {
          accountNumber: 100005000,
          contraAccountNumber: 84010000,
          amountDebit: 500,
          date: '2025-05-01',
        },
        {
          accountNumber: 40000000,
          contraAccountNumber: 700000000,
          amountDebit: 300,
          date: '2025-05-02',
        },
      ]
    );
    datevStore.set(dataset, '13540:20250101');
    expect(dataset.header.accountLength).toBe(5);

    const result = getOpenItems({});
    expect(result.count).toBe(2);
    expect(
      result.items.find((item) => item.account === '100005')?.accountType
    ).toBe('debtor');
    expect(
      result.items.find((item) => item.account === '700000')?.accountType
    ).toBe('creditor');
  });

  it('deckt den gesamten Sachkontenlängen-Bereich 4–8 ab (Padding 4–0)', () => {
    // Länge 6 → Padding 2, Länge 7 → Padding 1, Länge 8 → Padding 0.
    expect(detectAccountPadding([12345600, 123456700])).toBe(2);
    expect(detectAccountPadding([12345670, 123456780])).toBe(1);
    expect(detectAccountPadding([12345678, 123456789])).toBe(0);

    expect(datevAccountToDisplay(123456700, 2)).toBe('1234567'); // Länge 6
    expect(datevAccountToDisplay(123456780, 1)).toBe('12345678'); // Länge 7
    // Länge 8: kein Padding, Wert bleibt unverändert.
    expect(datevAccountToDisplay(123456789, 0)).toBe('123456789');
  });

  it('bestätigt die echten Länge-6-Rohnummern (Mandant 13481)', () => {
    // Padding 2 (= 8 − 6). Sachkonto 8-stellig, Personenkonto 9-stellig.
    expect(datevAccountToDisplay(12000000, 2)).toBe('120000'); // Bank (Sachkonto)
    expect(datevAccountToDisplay(700000000, 2)).toBe('7000000'); // Kreditor
  });

  it('erkennt Personenkonten auch bei Sachkontenlänge 6', () => {
    // Debitor 1234567 (roh 123456700), Kreditor 7000000 (roh 700000000).
    const dataset = buildCloudDataset(
      '99999-1',
      'Testmandant',
      20250101,
      { accountLength: 6, accountSystem: '03' },
      [
        {
          accountNumber: 123456700,
          contraAccountNumber: 12345600,
          amountDebit: 100,
          date: '2025-05-01',
        },
        {
          accountNumber: 40000000,
          contraAccountNumber: 700000000,
          amountDebit: 50,
          date: '2025-05-02',
        },
      ]
    );
    datevStore.set(dataset, 'l6');
    expect(dataset.header.accountLength).toBe(6);

    const result = getOpenItems({});
    expect(
      result.items.find((item) => item.account === '1234567')?.accountType
    ).toBe('debtor');
    expect(
      result.items.find((item) => item.account === '7000000')?.accountType
    ).toBe('creditor');
  });

  it('get_account_balance funktioniert bei Sachkontenlänge 8 (Padding 0)', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const dataset = buildCloudDataset(
      '99999-1',
      'Testmandant',
      20250101,
      { accountLength: 8, accountSystem: '03' },
      [{ accountNumber: 12345678, amountCredit: 1000, date: '2025-12-31' }]
    );
    datevStore.set(dataset, 'l8');
    expect(dataset.header.accountLength).toBe(8);

    const susa = JSON.stringify({
      accountNumber: 12345678,
      caption: 'Sachkonto lang',
      balance: 1000,
      balanceDebitCreditIdentifier: 'H',
    });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susa)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '12345678' });
    expect(result.konto).toBe(12345678);
    expect(result.saldo).toBe(-1000);
    expect(
      (result.verprobung as Record<string, unknown>).stimmtMitDatevUeberein
    ).toBe(true);
  });

  it('get_account_balance findet das Konto trotz technischer 8-Steller-SuSa', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20230101,
      { accountLength: 4, accountSystem: '03' },
      [{ accountNumber: 12000000, amountCredit: 70836.64, date: '2023-12-31' }]
    );
    datevStore.set(dataset, '455148-1:20230101');
    const susaTechnisch = JSON.stringify({
      accountNumber: 12000000,
      caption: 'Aareal Bank',
      balance: 70836.64,
      balanceDebitCreditIdentifier: 'H',
    });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susaTechnisch)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });

    expect(result.konto).toBe(1200);
    expect(result.saldo).toBe(-70836.64);
    expect(
      (result.verprobung as Record<string, unknown>).stimmtMitDatevUeberein
    ).toBe(true);
  });

  it('get_sums_and_balances filtert accountFrom/accountTo trotz technischer Nummern', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const susa = [
      JSON.stringify({
        accountNumber: 10000000,
        caption: 'Kasse',
        balance: 100,
        balanceDebitCreditIdentifier: 'S',
      }),
      JSON.stringify({
        accountNumber: 12000000,
        caption: 'Bank',
        balance: 200,
        balanceDebitCreditIdentifier: 'S',
      }),
      JSON.stringify({
        accountNumber: 84000000,
        caption: 'Erloese',
        balance: 300,
        balanceDebitCreditIdentifier: 'H',
      }),
    ].join('\n');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(susa)
    );
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.getSumsAndBalances({
      clientId: '455148-1',
      fiscalYearId: 20230101,
      accountFrom: 1000,
      accountTo: 1999,
    });
    const rows = result.salden as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2); // 1000 und 1200, nicht 8400
    expect(rows.map((r) => r.konto).sort()).toEqual([1000, 1200]);
  });

  it('get_open_items erkennt Personenkonten aus technischen 9-Steller-Buchungen', () => {
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20230101,
      { accountLength: 4, accountSystem: '03' },
      [
        {
          accountNumber: 104000000,
          contraAccountNumber: 84000000,
          amountDebit: 500,
          date: '2023-05-01',
        },
        {
          accountNumber: 49800000,
          contraAccountNumber: 700000000,
          amountDebit: 300,
          date: '2023-05-02',
        },
      ]
    );
    datevStore.set(dataset, 'k');

    const result = getOpenItems({});

    expect(result.count).toBe(2);
    expect(
      result.items.find((item) => item.account === '10400')?.accountType
    ).toBe('debtor');
    expect(
      result.items.find((item) => item.account === '70000')?.accountType
    ).toBe('creditor');
  });
});

describe('SuSa-Timeout-Härtung (Option B)', () => {
  afterEach(() => {
    datevStore.clear();
  });

  const timeoutError = (): Error =>
    Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });

  it('get_sums_and_balances: Timeout → klarer Hinweis auf datev_load_from_cloud', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      throw timeoutError();
    });
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.getSumsAndBalances({
      clientId: '455148-1',
      fiscalYearId: 20230101,
    });

    expect(result.status).toBe('zeitüberschreitung');
    expect(String(result.hinweis)).toContain('datev_load_from_cloud');
  });

  it('get_account_balance (Cloud): Timeout → Hinweis + Kontrollrechnung, kein saldo', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const dataset = buildCloudDataset(
      '455148-1',
      'Testmandant',
      20230101,
      { accountLength: 4, accountSystem: '03' },
      [{ accountNumber: 12000000, amountCredit: 70836.64, date: '2023-12-31' }]
    );
    datevStore.set(dataset, '455148-1:20230101');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      throw timeoutError();
    });
    const cloud = new CloudTools(config, fetchMock as unknown as FetchLike);

    const result = await cloud.accountBalance({ account: '1200' });

    expect(result.status).toBe('zeitüberschreitung');
    expect(String(result.hinweis)).toContain('datev_load_from_cloud');
    expect(result.saldo).toBeUndefined();
    expect(result.kontrolleAusBuchungen).toBe(-70836.64);
  });
});
