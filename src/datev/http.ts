/**
 * HTTP-Client für die DATEV-Cloud-APIs.
 *
 * Kapselt die drei wiederkehrenden Aufgaben jedes Aufrufs: gültiges Token
 * besorgen (über den {@link TokenManager}), Pflicht-Header setzen und
 * vorübergehende Fehler (429/503) begrenzt wiederholen. Fehlerantworten werden
 * in einen {@link DatevError} mit deutscher Meldung übersetzt.
 */
import type { DatevConfig } from '../config.js';
import type { FetchLike } from '../auth/oauth.js';
import type { TokenManager } from '../auth/token-manager.js';
import { readResponseText } from '../http/response.js';
import { datevErrorFromResponse } from './errors.js';

/** Abbruchzeit für einen einzelnen HTTP-Aufruf. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Maximale Zahl an Wiederholungen bei 429/503. */
const MAX_RETRIES = 2;
/** Maximale dekomprimierte Antwortgröße pro DATEV-Aufruf. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Hosts, an die ein DATEV-Bearer-Token übertragen werden darf. */
const TRUSTED_DATEV_API_HOSTS = new Set([
  'accounting-clients.api.datev.de',
  'accounting-data-exchange.api.datev.de',
]);

/** Baut eine URL nur innerhalb der festgelegten DATEV-Vertrauensgrenze. */
const trustedDatevUrl = (baseUrl: string, requestPath: string): URL => {
  const base = new URL(baseUrl);
  const url = new URL(baseUrl + requestPath);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    !TRUSTED_DATEV_API_HOSTS.has(base.hostname) ||
    url.origin !== base.origin
  ) {
    throw new Error(
      'Sicherheitsprüfung fehlgeschlagen: Zugangsdaten dürfen nur an freigegebene DATEV-HTTPS-Endpunkte gesendet werden.'
    );
  }
  return url;
};

/** Rohantwort eines DATEV-Aufrufs (Status, Header, unverarbeiteter Text). */
export interface DatevResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** Kleine Verzögerungshilfe für die Retry-Wartezeit. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Führt authentifizierte Aufrufe gegen die DATEV-Cloud-APIs aus. */
export class DatevHttpClient {
  /**
   * @param config - Aktive Konfiguration (liefert u. a. die Client-ID für den Header).
   * @param tokenManager - Quelle gültiger Zugriffstoken.
   * @param fetchImpl - Injizierbare `fetch`-Implementierung (für Tests).
   */
  constructor(
    private readonly config: DatevConfig,
    private readonly tokenManager: TokenManager,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /**
   * Führt einen Aufruf aus und liefert die Rohantwort.
   *
   * @param baseUrl - Basis-URL des Dienstes (aus der Konfiguration).
   * @param path - Pfad relativ zur Basis-URL (mit führendem `/`).
   * @param options - HTTP-Methode (Standard `GET`) und optionale Query-Parameter;
   *   `undefined`-Werte werden weggelassen.
   * @returns Die {@link DatevResponse} bei Erfolg (2xx).
   * @throws DatevError - bei jeder Nicht-2xx-Antwort (nach etwaigen Retries).
   * @remarks
   * Jeder Aufruf trägt zwei Pflicht-Nachweise: den `Authorization: Bearer`-Token
   * UND den `X-DATEV-Client-Id`-Header — DATEV verlangt beides gemeinsam.
   */
  async request(
    baseUrl: string,
    path: string,
    options: {
      method?: 'GET' | 'POST';
      query?: Record<string, string | number | undefined>;
    } = {}
  ): Promise<DatevResponse> {
    const url = trustedDatevUrl(baseUrl, path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      const accessToken = await this.tokenManager.getAccessToken();
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          // DATEV verlangt die OAuth-Client-ID zusätzlich als eigenen Header.
          'X-DATEV-Client-Id': this.config.clientId,
          Accept: 'application/json, application/x-ndjson',
        },
        // Credential-tragende Requests dürfen niemals einem Redirect folgen.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // 429 (Ratenlimit) und 503 (kurzzeitig nicht erreichbar) sind
      // vorübergehend: `Retry-After` respektieren, sonst linear zurückstufen.
      if (
        (response.status === 429 || response.status === 503) &&
        attempt < MAX_RETRIES
      ) {
        const retryAfter = Number.parseInt(
          response.headers.get('retry-after') ?? '',
          10
        );
        // `Retry-After` deckeln: Ein (fehlerhafter oder bösartiger) sehr großer
        // Wert dürfte den Aufruf nicht minuten-/tagelang blockieren.
        const retryAfterMs = Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter, 0), 30) * 1000
          : 2000 * (attempt + 1);
        // Body verwerfen, damit die Verbindung vor dem Retry freigegeben wird.
        await response.body?.cancel();
        await sleep(retryAfterMs);
        continue;
      }

      const text = await readResponseText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) {
        throw datevErrorFromResponse(response.status, text);
      }

      return { status: response.status, headers: response.headers, text };
    }
  }

  /**
   * Führt einen GET-Aufruf aus und parst die Antwort als einzelnes JSON-Objekt.
   *
   * @typeParam T - Erwarteter Antworttyp.
   */
  async getJson<T>(
    baseUrl: string,
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const response = await this.request(baseUrl, path, { query });
    return JSON.parse(response.text) as T;
  }

  /**
   * Führt einen GET-Aufruf aus und parst die Antwort als Liste.
   *
   * @typeParam T - Typ eines Listenelements.
   * @returns Die Elemente plus die Antwort-Header (für Paginierung, z. B.
   *   `x-total-count`/`x-total-pages`).
   * @remarks DATEV liefert Listen als NDJSON (ein JSON-Objekt pro Zeile),
   *   toleriert wird auch ein klassisches JSON-Array — siehe {@link parseNdjson}.
   */
  async getNdjson<T>(
    baseUrl: string,
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<{ items: T[]; headers: Headers; parseErrors: number }> {
    const response = await this.request(baseUrl, path, { query });
    const stats = { errors: 0 };
    const items = parseNdjson<T>(response.text, stats);
    return { items, headers: response.headers, parseErrors: stats.errors };
  }
}

/**
 * Parst NDJSON (ein JSON-Objekt je Zeile) und — als Toleranz — JSON-Arrays.
 *
 * @typeParam T - Typ eines Elements.
 * @param text - Roher Antworttext.
 * @returns Ein Array der geparsten Elemente; leerer/whitespace-Text ergibt `[]`.
 */
export const parseNdjson = <T>(
  text: string,
  stats?: { errors: number }
): T[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    // Ein klassisches JSON-Array — als Ganzes einlesen. Ist es beschädigt,
    // liefern wir eine leere Liste statt den ganzen Aufruf abzubrechen, zählen
    // den Fehler aber, damit die Unvollständigkeit sichtbar bleibt.
    try {
      return JSON.parse(trimmed) as T[];
    } catch {
      if (stats) {
        stats.errors += 1;
      }
      return [];
    }
  }

  // NDJSON: eine kaputte Zeile darf nicht den gesamten Ladevorgang scheitern
  // lassen — fehlerhafte Zeilen werden übersprungen und gezählt.
  const items: T[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) {
      continue;
    }
    try {
      items.push(JSON.parse(candidate) as T);
    } catch {
      if (stats) {
        stats.errors += 1;
      }
    }
  }
  return items;
};
