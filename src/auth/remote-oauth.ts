/**
 * Remote-DATEV-Anmeldung über den öffentlichen HTTPS-Callback (Phase 3).
 *
 * Im Fernbetrieb kann DATEV nicht auf `localhost` zurückleiten — der Callback
 * kommt am öffentlichen Endpunkt `/oauth/datev/callback` des Servers an. Dieser
 * Controller startet Anmeldevorgänge je Nutzer (persistenter Einmal-State aus
 * {@link PendingAuthorizationStore}) und verarbeitet den Callback: State
 * konsumieren (genau einmal), Code gegen Tokens tauschen und die Tokens im
 * verschlüsselten Slot **des richtigen Nutzers** ablegen.
 *
 * @remarks Der lokale Loopback-Flow (Claude Desktop) bleibt unverändert
 *   bestehen — welcher Weg gilt, entscheidet die Betriebsart des Entrypoints.
 */
import type { DatevConfig } from '../config.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  type FetchLike,
} from './oauth.js';
import type { PendingAuthorizationStore } from './pending-auth.js';
import type { EncryptedTokenRepository } from './token-repository.js';
import { tokenSlot } from './token-repository.js';
import type { RequestContext } from '../context/context.js';

/** Ergebnis der Callback-Verarbeitung (für die Browser-Antwort). */
export interface CallbackResult {
  ok: boolean;
  /** Kurze, nutzerfreundliche Meldung (wird HTML-maskiert ausgegeben). */
  message: string;
}

/** Startet und vollendet DATEV-Anmeldungen im Fernbetrieb. */
export class RemoteDatevOAuthController {
  /**
   * @param config - Aktive DATEV-Konfiguration (App-Zugangsdaten, Endpunkte).
   * @param redirectUri - Öffentliche Callback-URL (z. B.
   *   `https://datev-mcp.kanzlei.de/oauth/datev/callback`) — muss exakt so in
   *   der DATEV-App registriert sein.
   * @param pending - Persistente Einmal-Ablage der Anmeldevorgänge.
   * @param tokens - Verschlüsselte Mehrbenutzer-Token-Ablage.
   * @param fetchImpl - Injizierbare `fetch`-Implementierung (für Tests).
   */
  constructor(
    private readonly config: DatevConfig,
    private readonly redirectUri: string,
    private readonly pending: PendingAuthorizationStore,
    private readonly tokens: EncryptedTokenRepository,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /**
   * Startet einen Anmeldevorgang für den anfragenden Nutzer.
   *
   * @returns Die DATEV-Login-URL für den Browser des Nutzers.
   */
  beginLogin(ctx: RequestContext): { anmeldeUrl: string; anleitung: string } {
    const { state, challenge } = this.pending.begin(tokenSlot(ctx));
    return {
      anmeldeUrl: buildAuthorizeUrl(
        this.config,
        state,
        challenge,
        this.redirectUri
      ),
      anleitung:
        'Bitte diese URL im Browser öffnen und mit dem DATEV-Konto anmelden' +
        (this.config.environment === 'sandbox'
          ? ' (Sandbox: Benutzer "Test6" wählen).'
          : ' (SmartLogin, SmartCard oder mIDentity).') +
        ' Nach erfolgreicher Anmeldung zeigt datev_status "angemeldet: true".',
    };
  }

  /**
   * Verarbeitet den eingehenden DATEV-Callback.
   *
   * @param params - Query-Parameter des Callbacks (`state`, `code` bzw. `error`).
   * @returns Nutzerfreundliches Ergebnis; Details werden bewusst knapp gehalten.
   * @remarks Reihenfolge wie im Loopback-Flow: ZUERST den `state` konsumieren
   *   (einmalig — Replay/fremde States enden hier), erst danach `error`/`code`
   *   verarbeiten. Der Token-Austausch nutzt die öffentliche Redirect-URI.
   */
  async handleCallback(params: URLSearchParams): Promise<CallbackResult> {
    const state = params.get('state') ?? '';
    const pending = this.pending.consume(state);
    if (!pending) {
      return {
        ok: false,
        message:
          'Dieser Anmeldevorgang ist unbekannt, abgelaufen oder wurde bereits verwendet. Bitte in Claude erneut datev_login ausführen.',
      };
    }

    const error = params.get('error');
    if (error) {
      return {
        ok: false,
        message:
          'DATEV hat die Anmeldung abgelehnt oder sie wurde abgebrochen. Bitte in Claude erneut datev_login ausführen.',
      };
    }

    const code = params.get('code');
    if (!code) {
      return {
        ok: false,
        message:
          'Der Anmelde-Rückruf enthielt keinen Code. Bitte in Claude erneut datev_login ausführen.',
      };
    }

    try {
      const stored = await exchangeAuthorizationCode(
        this.config,
        code,
        pending.verifier,
        this.fetchImpl,
        this.redirectUri
      );
      this.tokens.save(pending.slot, stored);
      return {
        ok: true,
        message:
          'DATEV-Anmeldung erfolgreich. Sie können dieses Fenster schließen und in Claude weiterarbeiten.',
      };
    } catch {
      // Keine internen Details an den Browser (öffentlicher Endpunkt).
      return {
        ok: false,
        message:
          'Der Token-Austausch mit DATEV ist fehlgeschlagen. Bitte in Claude erneut datev_login ausführen.',
      };
    }
  }
}
