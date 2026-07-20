/**
 * Der Fernzugriff-Server (Phase 3): Streamable-HTTP-Endpunkt mit Türsteher.
 *
 * Bündelt alle öffentlichen Endpunkte des Fernbetriebs:
 *
 * - `POST/GET/DELETE /mcp` — der MCP-Endpunkt (Streamable HTTP). Jede Anfrage
 *   braucht ein gültiges **MCP-Zugangstoken** (Bearer); die Sitzung ist an den
 *   Nutzer des Tokens **gebunden** — eine `Mcp-Session-Id` allein autorisiert
 *   nie (Kernforderung des Reviews).
 * - OAuth-Eintrittstür: `/.well-known/*`, `/register`, `/authorize`, `/token`
 *   (siehe {@link McpOAuthServer}).
 * - `GET /oauth/datev/callback` — öffentlicher DATEV-Anmelde-Rückruf
 *   (siehe {@link RemoteDatevOAuthController}).
 * - `GET /healthz` — Lebenszeichen für Monitoring/Reverse Proxy (ohne Auth,
 *   ohne Interna).
 *
 * Schutzschichten: Bearer-Pflicht, Origin-Allowlist (DNS-Rebinding-Schutz des
 * SDK-Transports), Body-Größenlimit, einfaches Rate-Limit je Quell-IP,
 * Sicherheits-Header, generische Fehlermeldungen nach außen.
 *
 * @remarks TLS terminiert der vorgelagerte Reverse Proxy (nginx/Caddy/IIS,
 *   siehe BETRIEB-REMOTE-BRIEFING) — dieser Dienst bindet standardmäßig nur
 *   an 127.0.0.1.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAccessTokenIssuer } from '../auth/mcp-auth.js';
import type { PrincipalRegistry } from '../auth/principal-registry.js';
import type { RemoteDatevOAuthController } from '../auth/remote-oauth.js';
import type { RequestContext } from '../context/context.js';
import { createServer, type CreateServerOptions } from '../server.js';
import type { CloudTools } from '../tools/cloud.js';
import type { McpOAuthServer, EndpointResult } from './oauth-as.js';

/** Maximale Größe eines eingehenden Request-Bodys (JSON-RPC ist klein). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Rate-Limit: Anfragen je Quell-IP im Fenster. */
const RATE_LIMIT_MAX = 300;
/** Rate-Limit-Fenster in Millisekunden. */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Obergrenze gleichzeitig offener MCP-Sitzungen. */
const MAX_SESSIONS = 200;

/** Sicherheits-Header aller Antworten. */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/** Eine aktive MCP-Sitzung, fest an einen Nutzer-Slot gebunden. */
interface ActiveSession {
  transport: StreamableHTTPServerTransport;
  /** Nutzer-Slot (`organizationId|principalId`), dem die Sitzung gehört. */
  slot: string;
  createdAt: number;
}

/** Abhängigkeiten des Fernzugriff-Servers. */
export interface RemoteServerOptions {
  /** Öffentliche Basis-URL (für den WWW-Authenticate-Hinweis). */
  publicUrl: string;
  oauth: McpOAuthServer;
  issuer: McpAccessTokenIssuer;
  principals: PrincipalRegistry;
  datevCallback: RemoteDatevOAuthController;
  cloud: CloudTools;
  /** Erlaubte Browser-Origins für den MCP-Endpunkt (DNS-Rebinding-Schutz). */
  allowedOrigins?: string[];
  /** Weitere `createServer`-Optionen (Tests). */
  serverOptions?: Omit<CreateServerOptions, 'contextFactory' | 'cloud'>;
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown
): void => {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
};

const sendHtml = (
  res: http.ServerResponse,
  status: number,
  html: string
): void => {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(html);
};

const sendEndpointResult = (
  res: http.ServerResponse,
  result: EndpointResult
): void => {
  if (result.redirect) {
    res.writeHead(result.status, {
      ...SECURITY_HEADERS,
      Location: result.redirect,
    });
    res.end();
    return;
  }
  if (result.html !== undefined) {
    sendHtml(res, result.status, result.html);
    return;
  }
  sendJson(res, result.status, result.json ?? {});
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Erstellt den (noch nicht lauschenden) Fernzugriff-HTTP-Server. */
export const createRemoteServer = (
  options: RemoteServerOptions
): http.Server => {
  const sessions = new Map<string, ActiveSession>();
  const rateBuckets = new Map<string, { windowStart: number; count: number }>();

  const rateLimited = (ip: string): boolean => {
    const now = Date.now();
    const bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateBuckets.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    bucket.count += 1;
    if (rateBuckets.size > 10_000) {
      rateBuckets.clear(); // Speicher-Backstop; Limits starten dann neu.
    }
    return bucket.count > RATE_LIMIT_MAX;
  };

  /** Bearer-Token prüfen → Nutzer-Slot; `undefined` = nicht autorisiert. */
  const authenticate = (
    req: http.IncomingMessage
  ): { slot: string; ctx: () => RequestContext } | undefined => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const principal = token ? options.issuer.verify(token) : undefined;
    if (!principal) {
      return undefined;
    }
    // Mandanten-Allowlist des Kontos gilt für jede Anfrage dieser Sitzung.
    const account = options.principals.get(
      principal.principalId,
      principal.organizationId
    );
    if (!account) {
      // Konto inzwischen gesperrt → Token wirkt nicht mehr.
      return undefined;
    }
    const slot = `${principal.organizationId}|${principal.principalId}`;
    const allowedClients = account.allowedClients?.length
      ? new Set(account.allowedClients)
      : undefined;
    return {
      slot,
      ctx: () => ({
        principalId: principal.principalId,
        organizationId: principal.organizationId,
        requestId: crypto.randomUUID(),
        allowedClients,
      }),
    };
  };

  const handleMcp = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string | undefined
  ): Promise<void> => {
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, {
        ...SECURITY_HEADERS,
        // Weist den Client auf die OAuth-Eintrittstür hin (MCP-Authorization).
        'WWW-Authenticate': `Bearer resource_metadata="${options.publicUrl}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const parsedBody = body ? (JSON.parse(body) as unknown) : undefined;

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'unknown_session' });
        return;
      }
      // Sitzungs-Bindung: Die Session-Id allein autorisiert NIE — der Nutzer
      // des Bearer-Tokens muss der Eigentümer der Sitzung sein.
      if (session.slot !== auth.slot) {
        sendJson(res, 403, { error: 'session_owner_mismatch' });
        return;
      }
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Neue Sitzung (initialize): eigener McpServer + Transport, fest an den
    // authentifizierten Nutzer gebunden.
    if (req.method !== 'POST') {
      sendJson(res, 400, { error: 'missing_session' });
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      sendJson(res, 503, { error: 'too_many_sessions' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      // Antworten auf POSTs als schlichtes JSON (statt SSE-Stream) — unsere
      // Tools antworten ohnehin in einem Stück; das vereinfacht Clients,
      // Reverse-Proxy-Konfiguration und Tests.
      enableJsonResponse: true,
      ...(options.allowedOrigins?.length
        ? {
            enableDnsRebindingProtection: true,
            allowedOrigins: options.allowedOrigins,
          }
        : {}),
      onsessioninitialized: (newSessionId: string) => {
        sessions.set(newSessionId, {
          transport,
          slot: auth.slot,
          createdAt: Date.now(),
        });
      },
      onsessionclosed: (closedSessionId: string) => {
        sessions.delete(closedSessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const mcpServer = createServer({
      ...options.serverOptions,
      cloud: options.cloud,
      contextFactory: auth.ctx,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  };

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ip = req.socket.remoteAddress ?? 'unbekannt';

      if (rateLimited(ip)) {
        sendJson(res, 429, { error: 'rate_limited' });
        return;
      }

      try {
        // ---------------- Öffentliche Endpunkte ohne Anmeldung ----------------
        if (req.method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (
          req.method === 'GET' &&
          url.pathname === '/.well-known/oauth-authorization-server'
        ) {
          sendEndpointResult(res, options.oauth.metadata());
          return;
        }
        if (
          req.method === 'GET' &&
          url.pathname === '/.well-known/oauth-protected-resource'
        ) {
          sendEndpointResult(res, options.oauth.protectedResourceMetadata());
          return;
        }
        if (req.method === 'POST' && url.pathname === '/register') {
          const body = await readBody(req);
          sendEndpointResult(
            res,
            options.oauth.register(body ? JSON.parse(body) : {})
          );
          return;
        }
        if (req.method === 'GET' && url.pathname === '/authorize') {
          sendEndpointResult(res, options.oauth.authorize(url.searchParams));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/authorize') {
          const body = await readBody(req);
          sendEndpointResult(
            res,
            options.oauth.authorizeSubmit(new URLSearchParams(body))
          );
          return;
        }
        if (req.method === 'POST' && url.pathname === '/token') {
          const body = await readBody(req);
          sendEndpointResult(
            res,
            options.oauth.token(new URLSearchParams(body))
          );
          return;
        }
        if (req.method === 'GET' && url.pathname === '/oauth/datev/callback') {
          const result = await options.datevCallback.handleCallback(
            url.searchParams
          );
          sendHtml(
            res,
            result.ok ? 200 : 400,
            `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>DATEV-Anmeldung</title></head><body style="font-family:sans-serif;max-width:26rem;margin:4rem auto"><h1>${result.ok ? 'DATEV-Anmeldung erfolgreich' : 'DATEV-Anmeldung fehlgeschlagen'}</h1><p>${escapeHtml(result.message)}</p></body></html>`
          );
          return;
        }

        // ------------------------- MCP-Endpunkt (auth) ------------------------
        if (url.pathname === '/mcp') {
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          await handleMcp(req, res, body);
          return;
        }

        sendJson(res, 404, { error: 'not_found' });
      } catch (error) {
        const message =
          error instanceof Error && error.message === 'body_too_large'
            ? { status: 413, body: { error: 'body_too_large' } }
            : { status: 500, body: { error: 'internal_error' } };
        if (!res.headersSent) {
          sendJson(res, message.status, message.body);
        } else {
          res.end();
        }
      }
    })();
  });
};
