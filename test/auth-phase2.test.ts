/**
 * Tests für Phase 2 des Remote-Umbaus: verschlüsselte Mehrbenutzer-Token-
 * Ablage, Einmal-OAuth-State und eigene MCP-Zugangstokens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpAccessTokenIssuer } from '../src/auth/mcp-auth.js';
import { PendingAuthorizationStore } from '../src/auth/pending-auth.js';
import { EncryptedTokenRepository } from '../src/auth/token-repository.js';
import { FileTokenStore } from '../src/auth/token-store.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datev-phase2-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const tokens = (marker: string) => ({
  accessToken: `access-${marker}`,
  refreshToken: `refresh-${marker}`,
  expiresAt: Date.now() + 3_600_000,
});

describe('EncryptedTokenRepository', () => {
  it('speichert je Nutzer-Slot getrennt und liest verlustfrei zurück', () => {
    const repo = new EncryptedTokenRepository(
      path.join(tempDir, 'tokens.v2.json')
    );
    repo.save('kanzlei-a|anna', tokens('anna'));
    repo.save('kanzlei-a|bernd', tokens('bernd'));

    expect(repo.load('kanzlei-a|anna')?.accessToken).toBe('access-anna');
    expect(repo.load('kanzlei-a|bernd')?.accessToken).toBe('access-bernd');
    expect(repo.load('kanzlei-b|carla')).toBeUndefined();
    expect(repo.listSlots().sort()).toEqual([
      'kanzlei-a|anna',
      'kanzlei-a|bernd',
    ]);
  });

  it('legt keine Klartext-Tokens auf die Platte', () => {
    const filePath = path.join(tempDir, 'tokens.v2.json');
    const repo = new EncryptedTokenRepository(filePath);
    repo.save('kanzlei-a|anna', tokens('geheim'));

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('access-geheim');
    expect(raw).not.toContain('refresh-geheim');
    // Schlüsseldatei wurde restriktiv erzeugt (nur Unix prüfbar).
    if (process.platform !== 'win32') {
      const keyMode = fs.statSync(path.join(tempDir, 'token-key')).mode & 0o777;
      expect(keyMode).toBe(0o600);
    }
  });

  it('erkennt manipulierte Einträge (Auth-Tag) und liefert keine Tokens', () => {
    const filePath = path.join(tempDir, 'tokens.v2.json');
    const repo = new EncryptedTokenRepository(filePath);
    repo.save('kanzlei-a|anna', tokens('x'));

    const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entry = file.entries['kanzlei-a|anna'];
    const flipped = Buffer.from(entry.data, 'base64');
    flipped[0] = flipped[0] ^ 0xff;
    entry.data = flipped.toString('base64');
    fs.writeFileSync(filePath, JSON.stringify(file));

    expect(repo.load('kanzlei-a|anna')).toBeUndefined();
  });

  it('übernimmt die alte Klartext-Datei einmalig und löscht sie danach', () => {
    const legacyPath = path.join(tempDir, 'tokens.json');
    new FileTokenStore(legacyPath).save(tokens('legacy'));

    const repo = new EncryptedTokenRepository(
      path.join(tempDir, 'tokens.v2.json'),
      {
        legacyPath,
      }
    );
    // Erster Zugriff migriert…
    expect(repo.load('kanzlei-lokal|lokaler-nutzer')?.accessToken).toBe(
      'access-legacy'
    );
    // …die Klartext-Datei ist danach weg, die Tokens bleiben verfügbar.
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(repo.load('kanzlei-lokal|lokaler-nutzer')?.refreshToken).toBe(
      'refresh-legacy'
    );
  });

  it('clear entfernt nur den betroffenen Slot', () => {
    const repo = new EncryptedTokenRepository(
      path.join(tempDir, 'tokens.v2.json')
    );
    repo.save('kanzlei-a|anna', tokens('anna'));
    repo.save('kanzlei-a|bernd', tokens('bernd'));

    repo.clear('kanzlei-a|anna');
    expect(repo.load('kanzlei-a|anna')).toBeUndefined();
    expect(repo.load('kanzlei-a|bernd')?.accessToken).toBe('access-bernd');
  });

  it('lehnt einen ungültigen DATEV_TOKEN_KEY ab', () => {
    expect(
      () =>
        new EncryptedTokenRepository(path.join(tempDir, 't.json'), {
          keyBase64: 'zu-kurz',
        })
    ).toThrow(/32-Byte/);
  });
});

describe('PendingAuthorizationStore (Einmal-OAuth-State)', () => {
  it('ist genau einmal konsumierbar (Replay-Schutz)', () => {
    const store = new PendingAuthorizationStore(
      path.join(tempDir, 'pending.json')
    );
    const { state, challenge } = store.begin('kanzlei-a|anna');
    expect(challenge.length).toBeGreaterThan(20);

    const first = store.consume(state);
    expect(first?.slot).toBe('kanzlei-a|anna');
    expect(first?.verifier.length).toBeGreaterThan(20);
    // Zweiter Versuch (Replay) läuft ins Leere.
    expect(store.consume(state)).toBeUndefined();
  });

  it('überlebt einen Prozess-Neustart (persistente Ablage)', () => {
    const filePath = path.join(tempDir, 'pending.json');
    const { state } = new PendingAuthorizationStore(filePath).begin('k|n');

    // Neue Instanz (= neuer Prozess) kann denselben Vorgang konsumieren.
    expect(new PendingAuthorizationStore(filePath).consume(state)?.slot).toBe(
      'k|n'
    );
  });

  it('lässt abgelaufene Vorgänge verfallen und kennt fremde States nicht', () => {
    const store = new PendingAuthorizationStore(
      path.join(tempDir, 'pending.json')
    );
    const { state } = store.begin('k|n', -1); // sofort abgelaufen
    expect(store.consume(state)).toBeUndefined();
    expect(store.consume('voellig-fremder-state')).toBeUndefined();
    expect(store.count()).toBe(0);
  });
});

describe('McpAccessTokenIssuer (eigene Server-Zugangstokens)', () => {
  it('gibt Tokens aus und prüft sie auf den richtigen Nutzer', () => {
    const issuer = new McpAccessTokenIssuer(path.join(tempDir, 'mcp.json'));
    const { token } = issuer.issue('kanzlei-a|anna');

    const verified = issuer.verify(token);
    expect(verified?.organizationId).toBe('kanzlei-a');
    expect(verified?.principalId).toBe('anna');
    expect(issuer.verify('mcp_erfunden')).toBeUndefined();
    expect(issuer.verify('datev-access-token')).toBeUndefined();
  });

  it('speichert nur Hashes, nie das Token selbst', () => {
    const filePath = path.join(tempDir, 'mcp.json');
    const issuer = new McpAccessTokenIssuer(filePath);
    const { token } = issuer.issue('kanzlei-a|anna');

    expect(fs.readFileSync(filePath, 'utf8')).not.toContain(token);
  });

  it('abgelaufene Tokens werden abgelehnt', () => {
    const issuer = new McpAccessTokenIssuer(path.join(tempDir, 'mcp.json'), -1);
    const { token } = issuer.issue('kanzlei-a|anna');
    expect(issuer.verify(token)).toBeUndefined();
  });

  it('widerruft einzeln und je Nutzer (Offboarding)', () => {
    const issuer = new McpAccessTokenIssuer(path.join(tempDir, 'mcp.json'));
    const erste = issuer.issue('kanzlei-a|anna');
    const zweite = issuer.issue('kanzlei-a|anna');
    const fremde = issuer.issue('kanzlei-a|bernd');

    expect(issuer.revoke(erste.token)).toBe(true);
    expect(issuer.verify(erste.token)).toBeUndefined();
    expect(issuer.verify(zweite.token)).toBeDefined();

    expect(issuer.revokeAllFor('kanzlei-a|anna')).toBe(1);
    expect(issuer.verify(zweite.token)).toBeUndefined();
    // Der andere Nutzer bleibt unberührt.
    expect(issuer.verify(fremde.token)).toBeDefined();
  });
});
