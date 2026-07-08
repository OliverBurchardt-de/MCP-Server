/**
 * Verwaltet den Lebenszyklus der DATEV-Tokens.
 *
 * Kernaufgabe ist {@link TokenManager.getAccessToken}: Es liefert stets ein
 * gültiges Zugriffstoken und erneuert es bei Bedarf transparent über das
 * Refresh-Token — inklusive Rotation und Schutz vor parallelen Erneuerungen.
 */
import type { DatevConfig } from '../config.js';
import { refreshAccessToken, type FetchLike } from './oauth.js';
import { FileTokenStore, type StoredTokens } from './token-store.js';

/**
 * Zeitpuffer, ab dem ein Zugriffstoken proaktiv erneuert wird.
 *
 * @remarks
 * Wir erneuern 60 s vor Ablauf, damit ein gerade noch gültiges Token nicht
 * mitten in einem API-Aufruf verfällt.
 */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Signalisiert, dass keine (gültige) Anmeldung vorliegt.
 *
 * @remarks
 * Die Meldung ist bewusst handlungsleitend formuliert, weil sie direkt bei
 * Claude landet: Sie nennt das nächste Schritt-Tool (`datev_login`).
 */
export class NotLoggedInError extends Error {
  constructor() {
    super(
      'Keine DATEV-Anmeldung vorhanden oder abgelaufen. Bitte zuerst das Tool datev_login ausführen.'
    );
    this.name = 'NotLoggedInError';
  }
}

/** Kapselt Token-Speicher und -Erneuerung hinter einer einfachen API. */
export class TokenManager {
  private readonly store: FileTokenStore;
  /** Aktuell laufende Erneuerung (Single-Flight-Sperre), sonst `undefined`. */
  private refreshInFlight?: Promise<StoredTokens>;

  /**
   * @param config - Aktive Konfiguration (liefert u. a. den Token-Ablageort).
   * @param fetchImpl - Injizierbare `fetch`-Implementierung (für Tests).
   * @param store - Optionaler Token-Store; Standard ist ein {@link FileTokenStore}
   *   am konfigurierten Pfad.
   */
  constructor(
    private readonly config: DatevConfig,
    private readonly fetchImpl: FetchLike = fetch,
    store?: FileTokenStore
  ) {
    this.store = store ?? new FileTokenStore(config.tokenStorePath);
  }

  /** Persistiert frisch erhaltene Tokens (nach erfolgreichem Login). */
  saveTokens(tokens: StoredTokens): void {
    this.store.save(tokens);
  }

  /** Verwirft die gespeicherte Anmeldung (Abmelden). */
  clearTokens(): void {
    this.store.clear();
  }

  /** Liest die aktuell gespeicherten Tokens (oder `undefined`). */
  loadTokens(): StoredTokens | undefined {
    return this.store.load();
  }

  /**
   * Prüft, ob eine grundsätzlich nutzbare Anmeldung vorliegt.
   *
   * @returns `true`, wenn ein Refresh-Token existiert (auch bei abgelaufenem
   *   Zugriffstoken erneuerbar) oder das Zugriffstoken noch gültig ist.
   */
  isLoggedIn(): boolean {
    const tokens = this.store.load();
    return Boolean(
      tokens && (tokens.refreshToken || tokens.expiresAt > Date.now())
    );
  }

  /**
   * Liefert ein gültiges Zugriffstoken und erneuert es bei Bedarf.
   *
   * @returns Ein gültiges Bearer-Zugriffstoken.
   * @throws NotLoggedInError - wenn keine Tokens vorliegen, kein Refresh-Token
   *   existiert oder DATEV das Refresh-Token mit `invalid_grant` ablehnt (in
   *   diesem Fall wird der Speicher geleert, damit ein sauberer Neu-Login folgt).
   */
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

    // Single-Flight: Mehrere Tools können gleichzeitig ein Token anfordern.
    // Ohne diese Sperre würden parallele Aufrufe mehrere Refreshs auslösen —
    // DATEV rotiert das Refresh-Token, sodass alle bis auf einen ungültig würden.
    this.refreshInFlight ??= refreshAccessToken(
      this.config,
      tokens.refreshToken,
      this.fetchImpl
    )
      .then((fresh) => {
        // Rotierte Refresh-Tokens sofort persistieren, sonst ist die Sitzung
        // nach einem Prozess-Neustart verloren.
        const merged: StoredTokens = {
          ...fresh,
          refreshToken: fresh.refreshToken ?? tokens.refreshToken,
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
