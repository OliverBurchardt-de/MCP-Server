/**
 * Eingehende OAuth-Anmeldung des MCP-Servers (Phase 3 des Remote-Umbaus).
 *
 * Damit claude.ai (Custom Connector), Claude Desktop und Mobile sich mit dem
 * Server verbinden können, tritt er selbst als **OAuth-Autorisierungsserver**
 * auf (MCP-Authorization-Spezifikation): Metadata-Discovery, dynamische
 * Client-Registrierung (DCR), Authorize-Endpunkt und Token-Endpunkt (PKCE).
 *
 * Die Identität kommt aus der {@link PrincipalRegistry}: Auf der
 * Anmeldeseite weist sich die Mitarbeiterin/der Mitarbeiter mit dem von der
 * Kanzlei ausgegebenen **Zugangsschlüssel** aus. Nach erfolgreichem Tanz
 * stellt der Server ein eigenes MCP-Zugangstoken aus
 * ({@link McpAccessTokenIssuer}) — strikt getrennt vom DATEV-OAuth, das erst
 * innerhalb der Sitzung über `datev_login` folgt.
 *
 * @remarks Bewusst minimal: nur `authorization_code` + PKCE (S256), öffentliche
 *   Clients (`token_endpoint_auth_method: none`), Einmal-Codes mit kurzer
 *   Lebensdauer, exakte Redirect-URI-Prüfung, niemals Redirects an
 *   unvalidierte Ziele.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McpAccessTokenIssuer } from '../auth/mcp-auth.js';
import type { PrincipalRegistry } from '../auth/principal-registry.js';

/** Lebensdauer eines Authorization Codes (5 Minuten). */
const CODE_TTL_MS = 5 * 60 * 1000;
/** Obergrenze registrierter Clients (Schutz vor Registrierungs-Flut). */
const MAX_CLIENTS = 200;

/** Ein dynamisch registrierter OAuth-Client (z. B. claude.ai). */
interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

/** Ein einmalig einlösbarer Authorization Code. */
interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Nutzer-Slot (`organizationId|principalId`), für den das Token ausgestellt wird. */
  slot: string;
  expiresAt: number;
}

interface ClientsFile {
  version: 1;
  clients: RegisteredClient[];
}

interface CodesFile {
  version: 1;
  codes: AuthCodeRecord[];
}

/** Antwort eines Endpunkt-Handlers (Transport-neutral). */
export interface EndpointResult {
  status: number;
  /** JSON-Body (Content-Type application/json). */
  json?: unknown;
  /** HTML-Body (Content-Type text/html). */
  html?: string;
  /** 302-Ziel (bereits validierte Redirect-URI). */
  redirect?: string;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const s256 = (verifier: string): string =>
  crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

/** Prüft eine Client-Redirect-URI: HTTPS (oder lokal http) und wohlgeformt. */
const isAcceptableRedirectUri = (value: string): boolean => {
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};

/** Der OAuth-Autorisierungsserver für den eingehenden MCP-Zugang. */
export class McpOAuthServer {
  constructor(
    private readonly options: {
      /** Öffentliche Basis-URL des Servers (z. B. https://datev-mcp.kanzlei.de). */
      publicUrl: string;
      /** Ablagedatei der registrierten Clients. */
      clientsPath: string;
      /** Ablagedatei der Einmal-Codes. */
      codesPath: string;
      principals: PrincipalRegistry;
      issuer: McpAccessTokenIssuer;
    }
  ) {}

  // ---------- Datei-Helfer (gleiches Muster wie die übrigen Ablagen) ----------

  private readJson<T>(
    filePath: string,
    fallback: T,
    guard: (v: T) => boolean
  ): T {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
      if (guard(parsed)) {
        return parsed;
      }
    } catch {
      // Fehlt/beschädigt — Fallback.
    }
    return fallback;
  }

  private writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  private readClients(): ClientsFile {
    return this.readJson<ClientsFile>(
      this.options.clientsPath,
      { version: 1, clients: [] },
      (v) => v.version === 1 && Array.isArray(v.clients)
    );
  }

  private readCodes(): CodesFile {
    const file = this.readJson<CodesFile>(
      this.options.codesPath,
      { version: 1, codes: [] },
      (v) => v.version === 1 && Array.isArray(v.codes)
    );
    file.codes = file.codes.filter((record) => record.expiresAt > Date.now());
    return file;
  }

  // ------------------------------- Discovery -------------------------------

  /** RFC-8414-Metadaten (`/.well-known/oauth-authorization-server`). */
  metadata(): EndpointResult {
    const base = this.options.publicUrl;
    return {
      status: 200,
      json: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['datev'],
      },
    };
  }

  /** RFC-9728-Metadaten (`/.well-known/oauth-protected-resource`). */
  protectedResourceMetadata(): EndpointResult {
    const base = this.options.publicUrl;
    return {
      status: 200,
      json: {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
      },
    };
  }

  // --------------------- Dynamische Client-Registrierung --------------------

  /** `POST /register` — registriert einen öffentlichen Client (PKCE-Pflicht). */
  register(body: unknown): EndpointResult {
    const input = (body ?? {}) as {
      redirect_uris?: unknown;
      client_name?: unknown;
    };
    const redirectUris = Array.isArray(input.redirect_uris)
      ? input.redirect_uris.filter(
          (uri): uri is string =>
            typeof uri === 'string' && isAcceptableRedirectUri(uri)
        )
      : [];
    if (redirectUris.length === 0) {
      return {
        status: 400,
        json: {
          error: 'invalid_client_metadata',
          error_description:
            'redirect_uris muss mindestens eine gültige HTTPS-URL enthalten.',
        },
      };
    }

    const file = this.readClients();
    if (file.clients.length >= MAX_CLIENTS) {
      return {
        status: 429,
        json: { error: 'too_many_registrations' },
      };
    }

    const client: RegisteredClient = {
      clientId: 'client_' + crypto.randomBytes(16).toString('base64url'),
      redirectUris: redirectUris.slice(0, 10),
      clientName:
        typeof input.client_name === 'string'
          ? input.client_name.slice(0, 100)
          : undefined,
      createdAt: Date.now(),
    };
    file.clients.push(client);
    this.writeJson(this.options.clientsPath, file);

    return {
      status: 201,
      json: {
        client_id: client.clientId,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    };
  }

  // ------------------------------- Authorize --------------------------------

  private validateAuthorizeParams(
    params: URLSearchParams
  ):
    | {
        client: RegisteredClient;
        redirectUri: string;
        state: string;
        codeChallenge: string;
      }
    | { error: string } {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    const challengeMethod = params.get('code_challenge_method') ?? '';
    const responseType = params.get('response_type') ?? '';

    const client = this.readClients().clients.find(
      (candidate) => candidate.clientId === clientId
    );
    if (!client) {
      return { error: 'Unbekannter Client (client_id).' };
    }
    if (!client.redirectUris.includes(redirectUri)) {
      return {
        error: 'Die redirect_uri ist für diesen Client nicht registriert.',
      };
    }
    if (responseType !== 'code') {
      return { error: 'Nur response_type=code wird unterstützt.' };
    }
    if (!codeChallenge || challengeMethod !== 'S256') {
      return { error: 'PKCE (code_challenge, S256) ist erforderlich.' };
    }
    return { client, redirectUri, state, codeChallenge };
  }

  /** Baut die Anmeldeseite (Zugangsschlüssel-Formular). */
  private loginPage(
    params: URLSearchParams,
    errorMessage?: string
  ): EndpointResult {
    const hidden = [
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'response_type',
      'scope',
    ]
      .map((name) => {
        const value = params.get(name);
        return value
          ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
          : '';
      })
      .join('');
    return {
      status: errorMessage ? 401 : 200,
      html:
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DATEV-MCP: Anmeldung</title></head>` +
        `<body style="font-family:sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.3rem">DATEV-MCP-Server der Kanzlei</h1>` +
        `<p>Bitte melden Sie sich mit Ihrem pers&ouml;nlichen Zugangsschl&uuml;ssel an, um Claude mit dem Server zu verbinden.</p>` +
        (errorMessage
          ? `<p style="color:#b00020"><strong>${escapeHtml(errorMessage)}</strong></p>`
          : '') +
        `<form method="post" action="/authorize">${hidden}` +
        `<label for="key">Zugangsschl&uuml;ssel</label><br>` +
        `<input id="key" name="access_key" type="password" autocomplete="off" required style="width:100%;padding:.5rem;margin:.5rem 0"><br>` +
        `<button type="submit" style="padding:.5rem 1.5rem">Anmelden</button>` +
        `</form>` +
        `<p style="color:#666;font-size:.85rem">Ihren Zugangsschl&uuml;ssel erhalten Sie von der Kanzlei-Administration. Er wird hier nur gepr&uuml;ft, niemals gespeichert.</p>` +
        `</body></html>`,
    };
  }

  /** `GET /authorize` — validiert die Anfrage und zeigt die Anmeldeseite. */
  authorize(params: URLSearchParams): EndpointResult {
    const validated = this.validateAuthorizeParams(params);
    if ('error' in validated) {
      // NIE an eine unvalidierte redirect_uri weiterleiten — klare Fehlerseite.
      return {
        status: 400,
        html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fehler</title></head><body style="font-family:sans-serif;max-width:26rem;margin:4rem auto"><h1>Anmeldung nicht m&ouml;glich</h1><p>${escapeHtml(validated.error)}</p></body></html>`,
      };
    }
    return this.loginPage(params);
  }

  /** `POST /authorize` — prüft den Zugangsschlüssel und stellt den Code aus. */
  authorizeSubmit(form: URLSearchParams): EndpointResult {
    const validated = this.validateAuthorizeParams(form);
    if ('error' in validated) {
      return {
        status: 400,
        html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fehler</title></head><body style="font-family:sans-serif;max-width:26rem;margin:4rem auto"><h1>Anmeldung nicht m&ouml;glich</h1><p>${escapeHtml(validated.error)}</p></body></html>`,
      };
    }

    const account = this.options.principals.verify(
      form.get('access_key') ?? ''
    );
    if (!account) {
      return this.loginPage(
        form,
        'Der Zugangsschlüssel ist ungültig oder gesperrt.'
      );
    }

    const record: AuthCodeRecord = {
      code: 'code_' + crypto.randomBytes(32).toString('base64url'),
      clientId: validated.client.clientId,
      redirectUri: validated.redirectUri,
      codeChallenge: validated.codeChallenge,
      slot: `${account.organizationId}|${account.principalId}`,
      expiresAt: Date.now() + CODE_TTL_MS,
    };
    const file = this.readCodes();
    file.codes.push(record);
    this.writeJson(this.options.codesPath, file);

    const target = new URL(validated.redirectUri);
    target.searchParams.set('code', record.code);
    if (validated.state) {
      target.searchParams.set('state', validated.state);
    }
    return { status: 302, redirect: target.toString() };
  }

  // --------------------------------- Token ----------------------------------

  /** `POST /token` — löst den Einmal-Code (mit PKCE) gegen ein MCP-Token ein. */
  token(form: URLSearchParams): EndpointResult {
    if (form.get('grant_type') !== 'authorization_code') {
      return {
        status: 400,
        json: { error: 'unsupported_grant_type' },
      };
    }
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const clientId = form.get('client_id') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';

    // Code GENAU EINMAL konsumieren (auch bei fehlschlagender Prüfung danach —
    // ein einmal vorgelegter Code ist verbrannt).
    const file = this.readCodes();
    const record = file.codes.find((candidate) => candidate.code === code);
    file.codes = file.codes.filter((candidate) => candidate.code !== code);
    this.writeJson(this.options.codesPath, file);

    if (
      !record ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      !verifier ||
      s256(verifier) !== record.codeChallenge
    ) {
      return {
        status: 400,
        json: { error: 'invalid_grant' },
      };
    }

    const { token, expiresAt } = this.options.issuer.issue(record.slot);
    return {
      status: 200,
      json: {
        access_token: token,
        token_type: 'bearer',
        expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
        scope: 'datev',
      },
    };
  }
}
