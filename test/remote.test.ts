/**
 * End-to-End-Tests des Fernbetriebs (Phase 3): kompletter OAuth-Tanz
 * (Discovery → Registrierung → Zugangsschlüssel → Code → Token), Bearer-Schutz
 * des MCP-Endpunkts, Sitzungs-Bindung an den Nutzer und der öffentliche
 * DATEV-Callback (Einmal-State, richtige Slot-Zuordnung, Replay-Schutz).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { McpAccessTokenIssuer } from '../src/auth/mcp-auth.js';
import { PendingAuthorizationStore } from '../src/auth/pending-auth.js';
import { PrincipalRegistry } from '../src/auth/principal-registry.js';
import { RemoteDatevOAuthController } from '../src/auth/remote-oauth.js';
import type { FetchLike } from '../src/auth/oauth.js';
import { McpOAuthServer } from '../src/http/oauth-as.js';
import { createRemoteServer } from '../src/http/remote-server.js';
import { datevStore } from '../src/store/memory.js';
import { CloudTools } from '../src/tools/cloud.js';

let tempDir: string;
let server: http.Server;
let baseUrl: string;
let registry: PrincipalRegistry;
let issuer: McpAccessTokenIssuer;
let controller: RemoteDatevOAuthController;
let cloud: CloudTools;

/** Gemockter DATEV-Token-Endpunkt für den Callback-Test. */
const datevFetchMock: FetchLike = async () =>
  new Response(
    JSON.stringify({
      access_token: 'datev-access',
      refresh_token: 'datev-refresh',
      expires_in: 3600,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-remote-'));
  datevStore.clear();

  const config = loadConfig({
    DATEV_ENV: 'sandbox',
    DATEV_CLIENT_ID: 'test-client-id',
    DATEV_CLIENT_SECRET: 'test-secret',
    DATEV_TOKEN_STORE: path.join(tempDir, 'tokens.json'),
  });

  registry = new PrincipalRegistry(path.join(tempDir, 'principals.json'));
  issuer = new McpAccessTokenIssuer(path.join(tempDir, 'mcp-tokens.json'));
  const pending = new PendingAuthorizationStore(
    path.join(tempDir, 'pending.json')
  );

  cloud = new CloudTools(config, datevFetchMock);
  controller = new RemoteDatevOAuthController(
    config,
    'https://mcp.example.de/oauth/datev/callback',
    pending,
    cloud.tokenRepository,
    datevFetchMock
  );
  cloud.useRemoteLogin(controller);

  const oauth = new McpOAuthServer({
    publicUrl: 'https://mcp.example.de',
    clientsPath: path.join(tempDir, 'oauth-clients.json'),
    codesPath: path.join(tempDir, 'oauth-codes.json'),
    principals: registry,
    issuer,
  });

  server = createRemoteServer({
    publicUrl: 'https://mcp.example.de',
    oauth,
    issuer,
    principals: registry,
    datevCallback: controller,
    cloud,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server ohne Portnummer');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Führt den kompletten OAuth-Tanz aus und liefert ein MCP-Zugangstoken. */
const obtainAccessToken = async (accessKey: string): Promise<string> => {
  const registerResponse = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Test-Client',
    }),
  });
  expect(registerResponse.status).toBe(201);
  const { client_id: clientId } = (await registerResponse.json()) as {
    client_id: string;
  };

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code',
    state: 'client-state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const formResponse = await fetch(`${baseUrl}/authorize?${authorizeParams}`);
  expect(formResponse.status).toBe(200);
  expect(await formResponse.text()).toContain('Zugangsschl');

  const submitResponse = await fetch(`${baseUrl}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(authorizeParams),
      access_key: accessKey,
    }).toString(),
    redirect: 'manual',
  });
  expect(submitResponse.status).toBe(302);
  const location = new URL(submitResponse.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe(
    'https://claude.ai/api/mcp/auth_callback'
  );
  expect(location.searchParams.get('state')).toBe('client-state-123');
  const code = location.searchParams.get('code') ?? '';
  expect(code.length).toBeGreaterThan(10);

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    }).toString(),
  });
  expect(tokenResponse.status).toBe(200);
  const tokenBody = (await tokenResponse.json()) as { access_token: string };
  return tokenBody.access_token;
};

/** Initialisiert eine MCP-Sitzung und liefert deren Session-Id. */
const initializeSession = async (accessToken: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id') ?? '';
  expect(sessionId.length).toBeGreaterThan(10);
  await response.body?.cancel();
  return sessionId;
};

describe('Fernbetrieb: Türsteher und OAuth-Eintrittstür', () => {
  it('healthz antwortet ohne Anmeldung, MCP verlangt ein Bearer-Token', async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      'oauth-protected-resource'
    );
  });

  it('Discovery-Metadaten nennen die OAuth-Endpunkte', async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.authorization_endpoint).toBe(
      'https://mcp.example.de/authorize'
    );
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('kompletter Tanz: Registrierung → Schlüssel → Code → Token → Toolaufruf', async () => {
    const { accessKey } = registry.add({
      principalId: 'ob',
      organizationId: 'kanzlei-burchardt',
    });
    const accessToken = await obtainAccessToken(accessKey);
    const sessionId = await initializeSession(accessToken);

    // Mit gültiger Sitzung: Tool-Liste abrufen.
    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(toolsResponse.status).toBe(200);
    const toolsText = await toolsResponse.text();
    expect(toolsText).toContain('get_account_balance');
    expect(toolsText).toContain('datev_logout');
  });

  it('weist einen falschen Zugangsschlüssel ab (keine Weiterleitung)', async () => {
    registry.add({ principalId: 'ob', organizationId: 'k' });
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/cb'] }),
    });
    const { client_id: clientId } = (await registerResponse.json()) as {
      client_id: string;
    };
    const submit = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: 'https://claude.ai/cb',
        response_type: 'code',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        access_key: 'kzl_voellig-falsch',
      }).toString(),
      redirect: 'manual',
    });
    expect(submit.status).toBe(401);
    expect(await submit.text()).toContain('ungültig');
  });

  it('bindet die Sitzung an den Nutzer: fremdes Token wird abgewiesen', async () => {
    const anna = registry.add({ principalId: 'anna', organizationId: 'k' });
    const accessTokenAnna = await obtainAccessToken(anna.accessKey);
    const sessionAnna = await initializeSession(accessTokenAnna);

    // Bernd (gültiges Konto + Token) versucht, Annas Sitzung zu benutzen.
    registry.add({ principalId: 'bernd', organizationId: 'k' });
    const tokenBernd = issuer.issue('k|bernd').token;
    const hijack = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokenBernd}`,
        'Mcp-Session-Id': sessionAnna,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(403);
  });

  it('ein gesperrtes Konto verliert sofort den Zugang (trotz gültigem Token)', async () => {
    const { accessKey } = registry.add({
      principalId: 'ex',
      organizationId: 'k',
    });
    const accessToken = await obtainAccessToken(accessKey);
    registry.disable('ex', 'k');

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(response.status).toBe(401);
  });
});

describe('Fernbetrieb: öffentlicher DATEV-Callback', () => {
  it('ordnet den Callback dem richtigen Nutzer zu und speichert dessen Tokens', async () => {
    const ctx = {
      principalId: 'ob',
      organizationId: 'kanzlei-burchardt',
      requestId: 'r1',
    };
    const { anmeldeUrl } = controller.beginLogin(ctx);
    const state = new URL(anmeldeUrl).searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(10);
    // Die Anmelde-URL nutzt die ÖFFENTLICHE Redirect-URI, nicht localhost.
    expect(new URL(anmeldeUrl).searchParams.get('redirect_uri')).toBe(
      'https://mcp.example.de/oauth/datev/callback'
    );

    const callback = await fetch(
      `${baseUrl}/oauth/datev/callback?state=${encodeURIComponent(state)}&code=datev-code`
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('erfolgreich');

    // Tokens liegen im Slot GENAU DIESES Nutzers.
    expect(
      cloud.tokenRepository.load('kanzlei-burchardt|ob')?.accessToken
    ).toBe('datev-access');
    expect(
      cloud.tokenRepository.load('kanzlei-burchardt|fremd')
    ).toBeUndefined();

    // Replay desselben States wird abgewiesen.
    const replay = await fetch(
      `${baseUrl}/oauth/datev/callback?state=${encodeURIComponent(state)}&code=datev-code`
    );
    expect(replay.status).toBe(400);
  });

  it('unbekannte States erhalten eine generische Fehlerseite', async () => {
    const response = await fetch(
      `${baseUrl}/oauth/datev/callback?state=erfunden&code=x`
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('fehlgeschlagen');
    expect(text).not.toContain('Stacktrace');
  });
});
