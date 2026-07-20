/**
 * Reine OAuth-2.0-Bausteine für den DATEV-Login (Authorization Code + PKCE).
 *
 * Dieses Modul enthält nur zustandslose Funktionen: PKCE-Paar erzeugen,
 * Authorize-URL bauen, Code bzw. Refresh-Token gegen Zugriffstoken tauschen.
 * Der eigentliche Ablauf (Browser öffnen, Callback empfangen) liegt in
 * {@link file://./loopback.ts}, die Token-Verwaltung in
 * {@link file://./token-manager.ts}.
 *
 * @remarks
 * DATEV verlangt PKCE (S256) und unterstützt **kein** `client_credentials` —
 * jeder Zugriff erfolgt im Namen eines echten DATEV-Nutzers.
 */
import crypto from 'node:crypto';
import type { DatevConfig } from '../config.js';
import { readResponseText } from '../http/response.js';
import type { StoredTokens } from './token-store.js';

/** Zeitlimit für einen Token-Austausch (Code-Einlösung/Refresh). */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
/** Token-Antworten sind klein; größere Bodies deuten auf Fehlverhalten hin. */
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;

/**
 * Signatur der globalen `fetch`-Funktion.
 *
 * @remarks
 * Wird überall als injizierbarer Parameter genutzt, damit Tests `fetch` durch
 * einen Mock ersetzen können, ohne echte Netzwerkaufrufe auszulösen.
 */
export type FetchLike = typeof globalThis.fetch;

/** PKCE-Paar: geheimer `verifier` und daraus abgeleiteter `challenge`. */
export interface PkcePair {
  /** Zufälliges Geheimnis, das nur der Client kennt und beim Token-Tausch sendet. */
  verifier: string;
  /** SHA-256-Hash des Verifiers (base64url), der in der Authorize-URL steht. */
  challenge: string;
}

/**
 * Erzeugt ein frisches PKCE-Paar (Proof Key for Code Exchange, Methode S256).
 *
 * @returns Ein {@link PkcePair}; der `verifier` muss bis zum Token-Tausch
 *   aufbewahrt und dort mitgesendet werden.
 */
export const createPkcePair = (): PkcePair => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
};

/**
 * Erzeugt einen zufälligen `state`-Wert zur CSRF-Absicherung des OAuth-Flows.
 *
 * @returns Ein unvorhersehbarer, URL-sicherer String, der im Callback gegen den
 *   gesendeten Wert geprüft wird.
 */
export const createState = (): string =>
  crypto.randomBytes(16).toString('base64url');

/**
 * Baut die Authorize-URL, auf die der Nutzer im Browser geleitet wird.
 *
 * @param config - Aktive Konfiguration (liefert Authorize-Endpunkt, Client-ID,
 *   Redirect-URI und Scopes).
 * @param state - CSRF-Token aus {@link createState}.
 * @param challenge - PKCE-Challenge aus {@link createPkcePair}.
 * @returns Die vollständige Login-URL inklusive Query-Parameter.
 */
export const buildAuthorizeUrl = (
  config: DatevConfig,
  state: string,
  challenge: string
): string => {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
};

/** Rohantwort des DATEV-Token-Endpunkts (snake_case gemäß OAuth-Standard). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/**
 * Wandelt die OAuth-Rohantwort in das intern gespeicherte {@link StoredTokens}-Format.
 *
 * @remarks
 * `expires_in` ist relativ (Sekunden). Wir rechnen sofort in einen absoluten
 * Ablaufzeitpunkt (`expiresAt`) um, damit der {@link TokenManager} später ohne
 * die ursprüngliche Antwortzeit entscheiden kann, ob erneuert werden muss.
 * Fehlt `expires_in`, wird konservativ mit 300 s (5 min) gerechnet.
 */
const toStoredTokens = (response: TokenResponse): StoredTokens => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  expiresAt: Date.now() + (response.expires_in ?? 300) * 1000,
  scope: response.scope,
  // Das ID-Token wird bewusst NICHT übernommen/persistiert (aktuell ungenutzt;
  // weniger sensible Daten auf der Platte).
});

/**
 * Sendet eine POST-Anfrage an den Token-Endpunkt und normalisiert die Antwort.
 *
 * @remarks
 * Der Client authentifiziert sich per HTTP-Basic-Auth (client_id:client_secret).
 * Gemeinsame Basis für Code-Einlösung und Token-Refresh; der Unterschied liegt
 * nur im `body`.
 *
 * @throws Error - wenn der Endpunkt keinen 2xx-Status liefert (inkl. gekürztem
 *   Antworttext, damit z. B. `invalid_grant` sichtbar bleibt).
 */
const requestTokens = async (
  config: DatevConfig,
  body: URLSearchParams,
  fetchImpl: FetchLike
): Promise<StoredTokens> => {
  const basicAuth = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString('base64');
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json',
    },
    body: body.toString(),
    // Keine Redirects mit dem Basic-Auth-Header verfolgen. Der konfigurierte
    // DATEV-Endpunkt muss selbst die endgültige Antwort liefern.
    redirect: 'error',
    // Eigenes Zeitlimit für den Token-Austausch: Ein hängender Request darf den
    // Login-Vorgang nicht unbegrenzt offen halten (der Callback-Server-Timeout
    // beendet nur den Listener, nicht einen laufenden Token-Request).
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  const text = await readResponseText(response, MAX_TOKEN_RESPONSE_BYTES);
  if (!response.ok) {
    throw new Error(
      `DATEV-Token-Endpunkt antwortete mit HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  return toStoredTokens(JSON.parse(text) as TokenResponse);
};

/**
 * Tauscht den vom Callback erhaltenen Authorization Code gegen Tokens.
 *
 * @param config - Aktive Konfiguration (Token-Endpunkt, Redirect-URI, Client-Creds).
 * @param code - Der Authorization Code aus dem Redirect.
 * @param verifier - Der PKCE-Verifier, der zur ursprünglichen Challenge gehört.
 * @param fetchImpl - Injizierbare `fetch`-Implementierung (Standard: global).
 * @returns Die frisch ausgestellten {@link StoredTokens} inkl. Refresh-Token.
 */
export const exchangeAuthorizationCode = (
  config: DatevConfig,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch
): Promise<StoredTokens> =>
  requestTokens(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
    fetchImpl
  );

/**
 * Erneuert das Zugriffstoken mithilfe des Refresh-Tokens.
 *
 * @param config - Aktive Konfiguration.
 * @param refreshToken - Das zuletzt gültige Refresh-Token.
 * @param fetchImpl - Injizierbare `fetch`-Implementierung (Standard: global).
 * @returns Frische {@link StoredTokens}; DATEV rotiert dabei i. d. R. auch das
 *   Refresh-Token — der Aufrufer muss das neue sofort persistieren.
 */
export const refreshAccessToken = (
  config: DatevConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch
): Promise<StoredTokens> =>
  requestTokens(
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    fetchImpl
  );
