import type { DatevConfig } from '../config.js';
import type { FetchLike } from '../auth/oauth.js';
import type { TokenManager } from '../auth/token-manager.js';
import { datevErrorFromResponse } from './errors.js';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export interface DatevResponse {
  status: number;
  headers: Headers;
  text: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DatevHttpClient {
  constructor(
    private readonly config: DatevConfig,
    private readonly tokenManager: TokenManager,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async request(
    baseUrl: string,
    path: string,
    options: { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined> } = {}
  ): Promise<DatevResponse> {
    const url = new URL(baseUrl + path);
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
          Accept: 'application/json, application/x-ndjson'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * (attempt + 1));
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        throw datevErrorFromResponse(response.status, text);
      }

      return { status: response.status, headers: response.headers, text };
    }
  }

  async getJson<T>(
    baseUrl: string,
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const response = await this.request(baseUrl, path, { query });
    return JSON.parse(response.text) as T;
  }

  /** DATEV liefert Listen als NDJSON (ein JSON-Objekt pro Zeile) oder als JSON-Array. */
  async getNdjson<T>(
    baseUrl: string,
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<{ items: T[]; headers: Headers }> {
    const response = await this.request(baseUrl, path, { query });
    return { items: parseNdjson<T>(response.text), headers: response.headers };
  }
}

export const parseNdjson = <T>(text: string): T[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as T[];
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
};
