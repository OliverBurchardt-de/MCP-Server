/**
 * Zentrale Konfiguration des DATEV-MCP-Servers.
 *
 * Sämtliche umgebungsabhängigen Werte (Sandbox vs. Produktion, OAuth-Endpunkte,
 * API-Basis-URLs, Speicherort der Tokens) werden hier aus Umgebungsvariablen
 * abgeleitet. Der Rest des Codes bezieht diese Werte ausschließlich über das
 * {@link DatevConfig}-Objekt und kennt keine URLs oder Zugangsdaten direkt.
 *
 * @remarks
 * Die Konfiguration ist bewusst dateibasiert/ENV-basiert gehalten, damit sie in
 * Claude Desktop pro Server-Eintrag gesetzt werden kann (siehe ANLEITUNG.md).
 */
import os from 'node:os';
import path from 'node:path';

/** DATEV-Umgebung: `sandbox` (Übungsumgebung) oder `production` (Echtdaten). */
export type DatevEnvironment = 'sandbox' | 'production';

/** Aufgelöste Laufzeitkonfiguration — von {@link loadConfig} erzeugt. */
export interface DatevConfig {
  /** Aktive Umgebung; steuert Endpunkte und Token-Ablage. */
  environment: DatevEnvironment;
  /** OAuth-Client-ID der im DATEV-Entwicklerportal registrierten App. */
  clientId: string;
  /** OAuth-Client-Secret der App (Confidential Client). */
  clientSecret: string;
  /** Authorization-Endpunkt (Login-Seite von DATEV). */
  authorizeUrl: string;
  /** Token-Endpunkt (Code- bzw. Refresh-Token-Einlösung). */
  tokenUrl: string;
  /** Port des lokalen Callback-Servers für den Login. */
  redirectPort: number;
  /** Vollständige Redirect-URI; muss exakt so bei DATEV registriert sein. */
  redirectUri: string;
  /** Angeforderte OAuth-Scopes (u. a. `offline_access` für den Refresh-Token). */
  scopes: string[];
  /** Basis-URL des accounting-clients-Dienstes (Mandantenliste). */
  accountingClientsBaseUrl: string;
  /** Basis-URL des Accounting-Data-Exchange-Dienstes (Buchungsdaten). */
  accountingDataExchangeBaseUrl: string;
  /** Pfad der lokalen Token-Datei (pro Umgebung getrennt). */
  tokenStorePath: string;
  /**
   * Freigegebener Ordner, aus dem `load_datev_file` Dateien laden darf.
   *
   * @remarks
   * Sicherheitsgrenze: Nur Dateien innerhalb dieses Ordners werden geladen.
   * Das verhindert, dass eine (ggf. per Prompt-Injection eingeschleuste)
   * Anweisung beliebige Dateien vom Rechner liest — etwa die Token-Datei oder
   * den Export eines anderen Mandanten. Über `DATEV_IMPORT_DIR` anpassbar.
   */
  importBaseDir: string;
  /**
   * Erlaubt das vereinfachte Legacy-/Testformat beim Dateiimport.
   *
   * @remarks
   * Standard **false**: In Produktion werden nur echte DATEV-Exporte mit
   * `EXTF`/`DTVF`-Kennung akzeptiert, damit fremde/beschädigte CSV-Dateien nicht
   * als gültiger Buchungsstapel durchgehen. Nur für Tests/Entwicklung per
   * `DATEV_ALLOW_LEGACY_FORMAT=true` einschaltbar.
   */
  allowLegacyFormat: boolean;
}

/**
 * Fest verdrahtete DATEV-Endpunkte je Umgebung.
 *
 * @remarks
 * Sandbox und Produktion unterscheiden sich nur in Host bzw. Basispfad:
 * Sandbox nutzt `openidsandbox` / `sandbox-api` / `platform-sandbox`,
 * Produktion die entsprechenden Live-Varianten.
 */
const ENDPOINTS: Record<
  DatevEnvironment,
  { authorize: string; token: string; basePath: string }
> = {
  sandbox: {
    authorize: 'https://login.datev.de/openidsandbox/authorize',
    token: 'https://sandbox-api.datev.de/token',
    basePath: 'platform-sandbox',
  },
  production: {
    authorize: 'https://login.datev.de/openid/authorize',
    token: 'https://api.datev.de/token',
    basePath: 'platform',
  },
};

/**
 * Baut die {@link DatevConfig} aus Umgebungsvariablen.
 *
 * Fehlt `DATEV_ENV` oder ist es ungleich `production`, wird bewusst die
 * sichere Sandbox gewählt. Fehlende Client-Zugangsdaten führen NICHT zum
 * Fehler — der Dateimodus funktioniert ohne DATEV-Login; erst die Cloud-Tools
 * prüfen `clientId`/`clientSecret`.
 *
 * @param env - Zu lesende Umgebung; Standard ist `process.env`. Der Parameter
 *   existiert vor allem, damit Tests eine kontrollierte Umgebung übergeben können.
 * @returns Die vollständig aufgelöste Laufzeitkonfiguration.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env
): DatevConfig => {
  const environment: DatevEnvironment =
    env.DATEV_ENV === 'production' ? 'production' : 'sandbox';
  const endpoints = ENDPOINTS[environment];
  const redirectPort = Number.parseInt(env.DATEV_REDIRECT_PORT ?? '53682', 10);

  return {
    environment,
    clientId: env.DATEV_CLIENT_ID ?? '',
    clientSecret: env.DATEV_CLIENT_SECRET ?? '',
    authorizeUrl: endpoints.authorize,
    tokenUrl: endpoints.token,
    redirectPort,
    redirectUri:
      env.DATEV_REDIRECT_URI ?? `http://localhost:${redirectPort}/callback`,
    scopes: (
      env.DATEV_SCOPES ??
      'openid profile offline_access datev:accounting:clients datev:accounting:exchange'
    ).split(/\s+/),
    accountingClientsBaseUrl: `https://accounting-clients.api.datev.de/${endpoints.basePath}/v2`,
    accountingDataExchangeBaseUrl: `https://accounting-data-exchange.api.datev.de/${endpoints.basePath}/v1`,
    tokenStorePath:
      env.DATEV_TOKEN_STORE ??
      path.join(os.homedir(), '.datev-mcp', `tokens-${environment}.json`),
    importBaseDir:
      env.DATEV_IMPORT_DIR ?? path.join(os.homedir(), '.datev-mcp', 'import'),
    allowLegacyFormat: env.DATEV_ALLOW_LEGACY_FORMAT === 'true',
  };
};

/** Prozessweit gemeinsam genutzte Konfiguration (einmalig beim Start gelesen). */
export const config = loadConfig();
