import type { DatevConfig } from '../config.js';
import { refreshAccessToken, type FetchLike } from './oauth.js';
import { FileTokenStore, type StoredTokens } from './token-store.js';

/** Puffer, ab dem ein Access-Token proaktiv erneuert wird. */
const REFRESH_MARGIN_MS = 60_000;

export class NotLoggedInError extends Error {
  constructor() {
    super(
      'Keine DATEV-Anmeldung vorhanden oder abgelaufen. Bitte zuerst das Tool datev_login ausführen.'
    );
    this.name = 'NotLoggedInError';
  }
}

export class TokenManager {
  private readonly store: FileTokenStore;
  private refreshInFlight?: Promise<StoredTokens>;

  constructor(
    private readonly config: DatevConfig,
    private readonly fetchImpl: FetchLike = fetch,
    store?: FileTokenStore
  ) {
    this.store = store ?? new FileTokenStore(config.tokenStorePath);
  }

  saveTokens(tokens: StoredTokens): void {
    this.store.save(tokens);
  }

  clearTokens(): void {
    this.store.clear();
  }

  loadTokens(): StoredTokens | undefined {
    return this.store.load();
  }

  isLoggedIn(): boolean {
    const tokens = this.store.load();
    return Boolean(tokens && (tokens.refreshToken || tokens.expiresAt > Date.now()));
  }

  async getAccessToken(): Promise<string> {
    const tokens = this.store.load();
    if (!tokens) {
      throw new NotLoggedInError();
    }

    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new NotLoggedInError();
    }

    // Single-Flight: parallele Tool-Aufrufe teilen sich einen Refresh.
    this.refreshInFlight ??= refreshAccessToken(this.config, tokens.refreshToken, this.fetchImpl)
      .then((fresh) => {
        // Rotierte Refresh-Tokens sofort persistieren, sonst ist die Sitzung
        // nach einem Prozess-Neustart verloren.
        const merged: StoredTokens = {
          ...fresh,
          refreshToken: fresh.refreshToken ?? tokens.refreshToken
        };
        this.store.save(merged);
        return merged;
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });

    try {
      const fresh = await this.refreshInFlight;
      return fresh.accessToken;
    } catch (error) {
      if (error instanceof Error && /invalid_grant/i.test(error.message)) {
        this.store.clear();
        throw new NotLoggedInError();
      }
      throw error;
    }
  }
}
