/**
 * Lokaler Callback-Server für den interaktiven DATEV-Login.
 *
 * DATEV leitet nach der Anmeldung im Browser auf eine Redirect-URI zurück.
 * Für den lokalen Betrieb (Claude Desktop) ist das ein kurzlebiger HTTP-Server
 * auf `localhost:<port>`, der genau einen Callback entgegennimmt, den Code
 * gegen Tokens tauscht und sich danach selbst beendet.
 *
 * @remarks
 * Der Login-Status wird in einer modulweiten Variablen gehalten
 * ({@link getLoginState}), weil MCP-Tools kurzlebig aufgerufen werden:
 * `datev_login` startet den Flow, ein späteres `datev_status` liest das Ergebnis.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { DatevConfig } from '../config.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  type FetchLike,
} from './oauth.js';
import type { TokenManager } from './token-manager.js';

/** Maximale Wartezeit auf den Login-Callback, danach gilt der Flow als abgebrochen. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Zustand des laufenden bzw. letzten Login-Vorgangs. */
export type LoginState =
  | { status: 'idle' }
  | { status: 'waiting'; authorizeUrl: string; startedAt: number }
  | { status: 'success'; finishedAt: number }
  | { status: 'error'; message: string; finishedAt: number };

/** Modulweiter Login-Zustand, gelesen von `datev_status`. */
let currentState: LoginState = { status: 'idle' };
/** Referenz auf den aktiven Callback-Server (für sauberes Schließen). */
let activeServer: http.Server | undefined;

/** Liefert den aktuellen {@link LoginState} (z. B. für das Tool `datev_status`). */
export const getLoginState = (): LoginState => currentState;

const closeServer = (): void => {
  activeServer?.close();
  activeServer = undefined;
};

/**
 * Maskiert HTML-Sonderzeichen, damit fremdgesteuerte Werte nicht als Markup
 * interpretiert werden (Schutz vor reflektiertem XSS auf der Callback-Seite).
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Vergleicht zwei Zeichenketten in konstanter Zeit (gegen Timing-Angriffe).
 *
 * @remarks Für den `state`-Vergleich: unterschiedliche Längen sind sofort
 *   ungleich; gleich lange werden über {@link crypto.timingSafeEqual} geprüft.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return (
    bufferA.length === bufferB.length &&
    crypto.timingSafeEqual(bufferA, bufferB)
  );
};

/** Erzeugt eine schlichte HTML-Seite, die dem Nutzer im Browser angezeigt wird. */
const htmlResponse = (title: string, body: string): string =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;

/**
 * Startet den lokalen Callback-Server und liefert die DATEV-Login-URL.
 *
 * Der Server nimmt genau einen Callback entgegen, tauscht den Code gegen Tokens
 * und beendet sich danach selbst. Der Fortschritt wird in {@link getLoginState}
 * abgelegt, damit ein späterer `datev_status`-Aufruf Erfolg/Fehler sieht.
 *
 * @param config - Aktive Konfiguration (Redirect-Port, Endpunkte, Client-Creds).
 * @param tokenManager - Empfänger der Tokens nach erfolgreicher Anmeldung.
 * @param fetchImpl - Injizierbare `fetch`-Implementierung (für Tests).
 * @returns Die Authorize-URL, die der Nutzer im Browser öffnen muss.
 * @throws Error - wenn `clientId`/`clientSecret` fehlen (App nicht registriert).
 */
export const startLoginFlow = (
  config: DatevConfig,
  tokenManager: TokenManager,
  fetchImpl: FetchLike = fetch
): string => {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'DATEV_CLIENT_ID und DATEV_CLIENT_SECRET sind nicht gesetzt. Bitte zuerst die App im DATEV-Entwicklerportal registrieren und die Werte in der Konfiguration hinterlegen (siehe ANLEITUNG.md).'
    );
  }

  closeServer();

  const state = createState();
  const { verifier, challenge } = createPkcePair();
  const authorizeUrl = buildAuthorizeUrl(config, state, challenge);

  // Der Callback darf genau EINMAL verarbeitet werden — schützt vor doppelter
  // Verarbeitung (z. B. paralleler Request), bevor der Server schließt.
  let consumed = false;

  const server = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? '/',
      `http://localhost:${config.redirectPort}`
    );
    if (url.pathname !== new URL(config.redirectUri).pathname) {
      res.writeHead(404).end();
      return;
    }

    // SICHERHEIT: `state` ZUERST prüfen — für Erfolgs- UND Fehler-Callbacks. Ein
    // Aufruf ohne gültigen state (etwa ein fremder oder lokaler Request mit
    // `?error=…`) darf den laufenden Login weder abbrechen noch Tokens speichern.
    // Bei Fehlschlag bleibt der Server bewusst offen und der Login-Zustand
    // unverändert, damit der echte Callback noch ankommen kann.
    const returnedState = url.searchParams.get('state');
    if (!constantTimeEqual(returnedState ?? '', state)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        htmlResponse(
          'Ungültiger Aufruf',
          'Der Sicherheits-Token (state) stimmt nicht. Sie können dieses Fenster schließen.'
        )
      );
      return;
    }

    if (consumed) {
      res.writeHead(400).end();
      return;
    }
    consumed = true;

    const finish = (ok: boolean, message: string): void => {
      res.writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(
        htmlResponse(
          ok ? 'DATEV-Anmeldung erfolgreich' : 'DATEV-Anmeldung fehlgeschlagen',
          `${message} Sie können dieses Fenster schließen.`
        )
      );
      closeServer();
    };

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? '';
      currentState = {
        status: 'error',
        message: `DATEV meldete: ${error} ${description}`.trim(),
        finishedAt: Date.now(),
      };
      finish(false, currentState.message);
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      currentState = {
        status: 'error',
        message: 'Ungültiger Callback (Code fehlt).',
        finishedAt: Date.now(),
      };
      finish(false, currentState.message);
      return;
    }

    exchangeAuthorizationCode(config, code, verifier, fetchImpl)
      .then((tokens) => {
        tokenManager.saveTokens(tokens);
        currentState = { status: 'success', finishedAt: Date.now() };
        finish(
          true,
          'Die Anmeldung war erfolgreich. Claude kann jetzt auf DATEV zugreifen.'
        );
      })
      .catch((exchangeError: unknown) => {
        const message =
          exchangeError instanceof Error
            ? exchangeError.message
            : String(exchangeError);
        currentState = { status: 'error', message, finishedAt: Date.now() };
        finish(false, message);
      });
  });

  server.on('error', (serverError) => {
    currentState = {
      status: 'error',
      message: `Callback-Server konnte nicht starten: ${serverError.message}`,
      finishedAt: Date.now(),
    };
    activeServer = undefined;
  });

  // Nur auf der Loopback-Adresse lauschen — der Callback ist rein lokal; ein
  // Binden auf alle Schnittstellen würde den Server unnötig im Netz exponieren.
  server.listen(config.redirectPort, '127.0.0.1');
  server.unref();
  setTimeout(() => {
    if (currentState.status === 'waiting') {
      currentState = {
        status: 'error',
        message:
          'Zeitüberschreitung: Es kam innerhalb von 10 Minuten kein Login-Callback an.',
        finishedAt: Date.now(),
      };
    }
    closeServer();
  }, LOGIN_TIMEOUT_MS).unref();

  activeServer = server;
  currentState = { status: 'waiting', authorizeUrl, startedAt: Date.now() };
  return authorizeUrl;
};
