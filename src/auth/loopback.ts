import http from 'node:http';
import type { DatevConfig } from '../config.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  type FetchLike
} from './oauth.js';
import type { TokenManager } from './token-manager.js';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type LoginState =
  | { status: 'idle' }
  | { status: 'waiting'; authorizeUrl: string; startedAt: number }
  | { status: 'success'; finishedAt: number }
  | { status: 'error'; message: string; finishedAt: number };

let currentState: LoginState = { status: 'idle' };
let activeServer: http.Server | undefined;

export const getLoginState = (): LoginState => currentState;

const closeServer = (): void => {
  activeServer?.close();
  activeServer = undefined;
};

const htmlResponse = (title: string, body: string): string =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p></body></html>`;

/**
 * Startet den lokalen Callback-Server und liefert die DATEV-Login-URL.
 * Der Server nimmt genau einen Callback entgegen, tauscht den Code gegen
 * Tokens und beendet sich danach selbst.
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.redirectPort}`);
    if (url.pathname !== new URL(config.redirectUri).pathname) {
      res.writeHead(404).end();
      return;
    }

    const finish = (ok: boolean, message: string): void => {
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
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
        finishedAt: Date.now()
      };
      finish(false, currentState.message);
      return;
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code || returnedState !== state) {
      currentState = {
        status: 'error',
        message: 'Ungültiger Callback (Code fehlt oder State stimmt nicht überein).',
        finishedAt: Date.now()
      };
      finish(false, currentState.message);
      return;
    }

    exchangeAuthorizationCode(config, code, verifier, fetchImpl)
      .then((tokens) => {
        tokenManager.saveTokens(tokens);
        currentState = { status: 'success', finishedAt: Date.now() };
        finish(true, 'Die Anmeldung war erfolgreich. Claude kann jetzt auf DATEV zugreifen.');
      })
      .catch((exchangeError: unknown) => {
        const message =
          exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
        currentState = { status: 'error', message, finishedAt: Date.now() };
        finish(false, message);
      });
  });

  server.on('error', (serverError) => {
    currentState = {
      status: 'error',
      message: `Callback-Server konnte nicht starten: ${serverError.message}`,
      finishedAt: Date.now()
    };
    activeServer = undefined;
  });

  server.listen(config.redirectPort);
  server.unref();
  setTimeout(() => {
    if (currentState.status === 'waiting') {
      currentState = {
        status: 'error',
        message: 'Zeitüberschreitung: Es kam innerhalb von 10 Minuten kein Login-Callback an.',
        finishedAt: Date.now()
      };
    }
    closeServer();
  }, LOGIN_TIMEOUT_MS).unref();

  activeServer = server;
  currentState = { status: 'waiting', authorizeUrl, startedAt: Date.now() };
  return authorizeUrl;
};
