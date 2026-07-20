/**
 * Entrypoint des Fernbetriebs: startet den Streamable-HTTP-Server.
 *
 * Konfiguration über Umgebungsvariablen (zusätzlich zu den bestehenden
 * DATEV_*-Variablen, siehe .env.example):
 *
 * - `MCP_PUBLIC_URL` (Pflicht) — öffentliche Basis-URL hinter dem Reverse
 *   Proxy, z. B. `https://datev-mcp.kanzlei.de`. Daraus leiten sich die
 *   OAuth-Metadaten und die DATEV-Callback-URL
 *   (`<MCP_PUBLIC_URL>/oauth/datev/callback`) ab — Letztere muss exakt so in
 *   der DATEV-App registriert sein.
 * - `MCP_BIND` (Standard `127.0.0.1`) — Bind-Adresse; TLS terminiert der
 *   Reverse Proxy, deshalb lauscht der Dienst nur lokal.
 * - `MCP_PORT` (Standard `3000`).
 * - `MCP_ALLOWED_ORIGINS` — optionale, kommagetrennte Browser-Origin-Allowlist
 *   für den MCP-Endpunkt (z. B. `https://claude.ai`).
 *
 * Der lokale stdio-Betrieb (Claude Desktop, `npm start`) bleibt unverändert —
 * dies ist ein eigener, zweiter Betriebsmodus.
 */
import path from 'node:path';
import { config } from './config.js';
import { McpAccessTokenIssuer } from './auth/mcp-auth.js';
import { PendingAuthorizationStore } from './auth/pending-auth.js';
import { PrincipalRegistry } from './auth/principal-registry.js';
import { RemoteDatevOAuthController } from './auth/remote-oauth.js';
import { McpOAuthServer } from './http/oauth-as.js';
import { createRemoteServer } from './http/remote-server.js';
import { CloudTools } from './tools/cloud.js';

const main = (): void => {
  const publicUrlRaw = process.env.MCP_PUBLIC_URL;
  if (!publicUrlRaw) {
    console.error(
      'MCP_PUBLIC_URL fehlt (z. B. https://datev-mcp.kanzlei.de). Ohne öffentliche Basis-URL kann der Fernbetrieb nicht starten.'
    );
    process.exit(1);
  }
  const publicUrl = publicUrlRaw.replace(/\/+$/, '');
  const parsed = new URL(publicUrl);
  const isLoopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    console.error(
      'MCP_PUBLIC_URL muss eine HTTPS-URL sein (Ausnahme: localhost für lokale Tests).'
    );
    process.exit(1);
  }

  const bind = process.env.MCP_BIND ?? '127.0.0.1';
  const port = Number.parseInt(process.env.MCP_PORT ?? '3000', 10);
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Gemeinsames Ablageverzeichnis (~/.datev-mcp bzw. DATEV_TOKEN_STORE-Ordner).
  const stateDir = path.dirname(config.tokenStorePath);
  const principals = new PrincipalRegistry(
    path.join(stateDir, 'principals.json')
  );
  const issuer = new McpAccessTokenIssuer(
    path.join(stateDir, 'mcp-tokens.json')
  );
  const pending = new PendingAuthorizationStore(
    path.join(stateDir, `pending-auth-${config.environment}.json`)
  );

  const cloud = new CloudTools(config, fetch);
  const datevCallback = new RemoteDatevOAuthController(
    config,
    `${publicUrl}/oauth/datev/callback`,
    pending,
    cloud.tokenRepository,
    fetch
  );
  cloud.useRemoteLogin(datevCallback);

  const oauth = new McpOAuthServer({
    publicUrl,
    clientsPath: path.join(stateDir, 'oauth-clients.json'),
    codesPath: path.join(stateDir, 'oauth-codes.json'),
    principals,
    issuer,
  });

  const server = createRemoteServer({
    publicUrl,
    oauth,
    issuer,
    principals,
    datevCallback,
    cloud,
    allowedOrigins,
  });

  server.listen(port, bind, () => {
    console.error(
      `DATEV-MCP-Fernbetrieb gestartet: http://${bind}:${port} (öffentlich: ${publicUrl}, Umgebung: ${config.environment}).`
    );
    console.error(
      `DATEV-Callback für die App-Registrierung: ${publicUrl}/oauth/datev/callback`
    );
  });
};

main();
