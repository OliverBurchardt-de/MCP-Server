/**
 * Admin-CLI: Nutzerkonten der Kanzlei verwalten (`npm run add-user`).
 *
 * Beispiele:
 *   npm run add-user -- --user ob --org kanzlei-burchardt
 *   npm run add-user -- --user azubi --org kanzlei-burchardt --clients 455148-1
 *   npm run add-user -- --list
 *   npm run add-user -- --disable --user azubi --org kanzlei-burchardt
 *
 * Der ausgegebene Zugangsschlüssel erscheint GENAU EINMAL — sicher an die
 * Mitarbeiterin/den Mitarbeiter übergeben (nicht per unverschlüsselter E-Mail).
 */
import path from 'node:path';
import { config } from '../config.js';
import { McpAccessTokenIssuer } from '../auth/mcp-auth.js';
import { PrincipalRegistry } from '../auth/principal-registry.js';

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const stateDir = path.dirname(config.tokenStorePath);
const registry = new PrincipalRegistry(path.join(stateDir, 'principals.json'));

const main = (): void => {
  if (hasFlag('list')) {
    const accounts = registry.list();
    if (accounts.length === 0) {
      console.log('Keine Nutzerkonten angelegt.');
      return;
    }
    for (const account of accounts) {
      console.log(
        `${account.organizationId} | ${account.principalId} | angelegt ${new Date(account.createdAt).toISOString().slice(0, 10)}${account.disabled ? ' | GESPERRT' : ''}`
      );
    }
    return;
  }

  const principalId = argValue('user');
  const organizationId = argValue('org');
  if (!principalId || !organizationId) {
    console.error(
      'Verwendung: npm run add-user -- --user <kennung> --org <kanzlei> [--clients 455148-1,413885-2] | --list | --disable --user <kennung> --org <kanzlei>'
    );
    process.exit(1);
  }

  if (hasFlag('disable')) {
    const disabled = registry.disable(principalId, organizationId);
    if (!disabled) {
      console.error('Kein aktives Konto mit dieser Kennung gefunden.');
      process.exit(1);
    }
    // Offboarding: auch alle aktiven MCP-Zugangstokens des Nutzers widerrufen.
    const issuer = new McpAccessTokenIssuer(
      path.join(stateDir, 'mcp-tokens.json')
    );
    const revoked = issuer.revokeAllFor(`${organizationId}|${principalId}`);
    console.log(
      `Konto gesperrt. ${revoked} aktive Zugangstoken(s) widerrufen. DATEV-Abmeldung: in Claude datev_logout ausführen oder Token-Slot leeren.`
    );
    return;
  }

  const allowedClients = argValue('clients')
    ?.split(',')
    .map((clientId) => clientId.trim())
    .filter((clientId) => clientId.length > 0);

  const { accessKey } = registry.add({
    principalId,
    organizationId,
    allowedClients,
  });
  console.log('Nutzerkonto angelegt.');
  console.log(`  Kanzlei: ${organizationId}`);
  console.log(`  Nutzer:  ${principalId}`);
  if (allowedClients?.length) {
    console.log(`  Mandanten-Allowlist: ${allowedClients.join(', ')}`);
  }
  console.log('');
  console.log('Zugangsschlüssel (erscheint nur EINMAL — sicher übergeben):');
  console.log(`  ${accessKey}`);
};

main();
