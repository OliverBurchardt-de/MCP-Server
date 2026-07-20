import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken, type FetchLike } from '../src/auth/oauth.js';
import { FileTokenStore } from '../src/auth/token-store.js';
import { TokenManager } from '../src/auth/token-manager.js';
import { loadConfig, type DatevConfig } from '../src/config.js';
import { DatevHttpClient } from '../src/datev/http.js';
import { AccountPostingsJobRunner } from '../src/datev/jobs.js';
import { readResponseText } from '../src/http/response.js';

const tempDirs: string[] = [];

const makeConfig = (): DatevConfig => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-security-'));
  tempDirs.push(tempDir);
  return loadConfig({
    DATEV_ENV: 'sandbox',
    DATEV_CLIENT_ID: 'test-client-id',
    DATEV_CLIENT_SECRET: 'test-secret',
    DATEV_TOKEN_STORE: path.join(tempDir, 'tokens.json'),
  });
};

const storeValidTokens = (config: DatevConfig): void => {
  new FileTokenStore(config.tokenStorePath).save({
    accessToken: 'valid-access-token',
    refreshToken: 'valid-refresh-token',
    expiresAt: Date.now() + 3_600_000,
  });
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('OAuth-Callback-Konfiguration', () => {
  it('akzeptiert nur einen HTTP-Loopback-Redirect mit passendem Port', () => {
    expect(
      loadConfig({
        DATEV_REDIRECT_PORT: '53682',
        DATEV_REDIRECT_URI: 'http://127.0.0.1:53682/custom-callback',
      }).redirectUri
    ).toBe('http://127.0.0.1:53682/custom-callback');

    expect(() =>
      loadConfig({
        DATEV_REDIRECT_PORT: '53682',
        DATEV_REDIRECT_URI: 'https://attacker.example/callback',
      })
    ).toThrow(/Loopback/);
    expect(() =>
      loadConfig({
        DATEV_REDIRECT_PORT: '53682',
        DATEV_REDIRECT_URI: 'http://localhost:12345/callback',
      })
    ).toThrow(/DATEV_REDIRECT_PORT/);
  });

  it('lehnt ungültige oder außerhalb des TCP-Bereichs liegende Ports ab', () => {
    expect(() => loadConfig({ DATEV_REDIRECT_PORT: '53682abc' })).toThrow(
      /ganze Zahl/
    );
    expect(() => loadConfig({ DATEV_REDIRECT_PORT: '0' })).toThrow(/zwischen/);
    expect(() => loadConfig({ DATEV_REDIRECT_PORT: '65536' })).toThrow(
      /zwischen/
    );
  });
});

describe('Credential-tragende HTTP-Aufrufe', () => {
  it('sendet Bearer-Tokens ausschließlich an freigegebene DATEV-Hosts', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi.fn();
    const client = new DatevHttpClient(
      config,
      new TokenManager(config, fetchMock as unknown as FetchLike),
      fetchMock as unknown as FetchLike
    );

    await expect(
      client.getJson('https://attacker.example/v1', '/steal')
    ).rejects.toThrow(/freigegebene DATEV-HTTPS-Endpunkte/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verbietet Redirects für Bearer- und Basic-Auth-Requests', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const apiFetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ ok: true })
    );
    const client = new DatevHttpClient(
      config,
      new TokenManager(config, apiFetch as unknown as FetchLike),
      apiFetch as unknown as FetchLike
    );

    await client.getJson(config.accountingClientsBaseUrl, '/clients');
    expect(apiFetch.mock.calls[0]?.[1]?.redirect).toBe('error');

    const tokenFetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ access_token: 'fresh', expires_in: 3600 })
    );
    await refreshAccessToken(
      config,
      'refresh',
      tokenFetch as unknown as FetchLike
    );
    expect(tokenFetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
});

describe('Grenzen für externe Antworten', () => {
  it('bricht bei angekündigten und tatsächlich gelesenen Übergrößen ab', async () => {
    await expect(
      readResponseText(
        new Response('x', { headers: { 'content-length': '100' } }),
        10
      )
    ).rejects.toThrow(/überschreitet/);
    await expect(readResponseText(new Response('12345'), 4)).rejects.toThrow(
      /überschreitet/
    );
  });

  it('bricht manipulierte leere Job-Paginierung früh und sichtbar ab', async () => {
    const config = makeConfig();
    storeValidTokens(config);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jobState: 'COMPLETED' }))
      .mockResolvedValueOnce(
        jsonResponse('', {
          headers: {
            'x-total-pages': '999999',
            'x-total-count': '999999',
          },
        })
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
      expect(result.truncated).toBe(true);
      expect(result.postings).toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
