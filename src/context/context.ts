/**
 * Anfrage-Kontext: Wer fragt, für welche Kanzlei, mit welchen Rechten?
 *
 * Dieses Modul ist das Fundament des Mehrbenutzer-Umbaus (Phase 1 des
 * Remote-Plans): Jede Tool-Ausführung erhält einen expliziten
 * {@link RequestContext} statt sich auf prozessglobalen Zustand zu verlassen.
 * Datensätze werden der Kanzlei ({@link RequestContext.organizationId})
 * zugeordnet, der „aktive Datensatz" dem einzelnen Nutzer
 * ({@link RequestContext.principalId}) — so können mehrere Mitarbeitende
 * dieselben geladenen Daten nutzen, ohne sich gegenseitig den aktiven
 * Datensatz zu verstellen, und ein Nutzer sieht nie Daten einer fremden
 * Kanzlei.
 *
 * @remarks
 * Im lokalen stdio-Betrieb (Claude Desktop) gibt es genau einen Nutzer — die
 * {@link createLocalContextFactory} liefert dafür einen festen Principal. Der
 * spätere Remote-Betrieb ersetzt nur die Fabrik (Kontext aus der
 * authentifizierten Verbindung) — Tools, Store und Autorisierung bleiben
 * unverändert. Genau dieser Schnitt macht den Transportwechsel tragfähig.
 */
import crypto from 'node:crypto';

/** Identität und Berechtigungsrahmen einer einzelnen Tool-Ausführung. */
export interface RequestContext {
  /** Eindeutige Kennung des handelnden Nutzers (Mitarbeiterin/Mitarbeiter). */
  principalId: string;
  /** Kanzlei/Organisation, der die geladenen Datensätze gehören. */
  organizationId: string;
  /** Eindeutige Kennung dieser Anfrage (für Logs/Korrelation). */
  requestId: string;
  /**
   * Erlaubte DATEV-Mandanten (clientId `Beraternr-Mandantennr`).
   * `undefined` = keine zusätzliche Einschränkung — es gilt allein, was das
   * DATEV-Konto des angemeldeten Nutzers sehen darf.
   */
  allowedClients?: ReadonlySet<string>;
}

/**
 * Serverseitige Mandanten-Autorisierung: wirft, wenn der Kontext den
 * DATEV-Mandanten nicht verwenden darf.
 *
 * @remarks Wird VOR jedem DATEV-Aufruf mit `clientId` geprüft — die
 *   Autorisierung hängt damit nicht von Modell-Entscheidungen ab. Ohne
 *   konfigurierte Allowlist gilt die Berechtigung des DATEV-Kontos selbst.
 * @throws Error - wenn eine Allowlist konfiguriert ist und den Mandanten
 *   nicht enthält.
 */
export const assertClientAllowed = (
  ctx: RequestContext,
  clientId: string
): void => {
  if (ctx.allowedClients && !ctx.allowedClients.has(clientId)) {
    throw new Error(
      `Zugriff verweigert: Der Mandant "${clientId}" ist für diesen Zugang nicht freigegeben (DATEV_ALLOWED_CLIENTS).`
    );
  }
};

/**
 * Baut die Kontext-Fabrik für den lokalen Einzelplatz-Betrieb (stdio).
 *
 * @param env - Umgebungsvariablen (injizierbar für Tests):
 *   - `DATEV_ORG_ID` — Kennung der Kanzlei (Standard `kanzlei-lokal`).
 *   - `DATEV_PRINCIPAL_ID` — Kennung des Nutzers (Standard `lokaler-nutzer`).
 *   - `DATEV_ALLOWED_CLIENTS` — optionale, kommagetrennte Mandanten-Allowlist
 *     (z. B. `455148-1,413885-2`); leer/ungesetzt = keine Einschränkung.
 * @returns Fabrik, die je Tool-Aufruf einen frischen Kontext (neue requestId)
 *   für den festen lokalen Principal liefert.
 */
export const createLocalContextFactory = (
  env: NodeJS.ProcessEnv = process.env
): (() => RequestContext) => {
  const organizationId = env.DATEV_ORG_ID?.trim() || 'kanzlei-lokal';
  const principalId = env.DATEV_PRINCIPAL_ID?.trim() || 'lokaler-nutzer';
  const allowedRaw = (env.DATEV_ALLOWED_CLIENTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const allowedClients =
    allowedRaw.length > 0 ? new Set(allowedRaw) : undefined;

  return () => ({
    principalId,
    organizationId,
    requestId: crypto.randomUUID(),
    allowedClients,
  });
};
