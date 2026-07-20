/**
 * Eigene MCP-Zugangstokens des Servers (Phase 2 des Remote-Umbaus).
 *
 * Zentrale Trennung zweier Sicherheitsebenen (Kernforderung des Reviews vom
 * 20.07.): Das **DATEV-Token** berechtigt den Server gegenüber DATEV — es ist
 * NIEMALS zugleich die Eintrittskarte eines Clients zum MCP-Server. Für den
 * eingehenden Zugang stellt der Server **eigene, an ihn gebundene Tokens**
 * aus: Nach erfolgreicher Anmeldung eines Nutzers wird ein zufälliges,
 * opakes Token ausgegeben; der Server speichert davon nur den **SHA-256-Hash**
 * samt Nutzer-Slot und Ablaufzeit. Ein entwendeter Ablagebestand enthält
 * damit keine verwendbaren Tokens.
 *
 * @remarks Die HTTP-Anbindung (Bearer-Prüfung am Streamable-HTTP-Endpunkt)
 *   folgt in Phase 3 — dieses Modul ist transportunabhängig und vollständig
 *   testbar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Standard-Lebensdauer eines MCP-Zugangstokens (8 Stunden). */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

/** Erkennungs-Präfix ausgegebener Tokens (erleichtert Secret-Scanning). */
const TOKEN_PREFIX = 'mcp_';

/** Gespeicherter Eintrag — bewusst NUR der Hash, nie das Token selbst. */
interface TokenRecord {
  /** SHA-256-Hex des ausgegebenen Tokens. */
  tokenHash: string;
  /** Nutzer-Slot (`organizationId|principalId`), für den das Token gilt. */
  slot: string;
  createdAt: number;
  expiresAt: number;
}

/** Dateiformat der Ablage. */
interface TokenFile {
  version: 1;
  tokens: TokenRecord[];
}

/** Ergebnis einer erfolgreichen Token-Prüfung. */
export interface VerifiedPrincipal {
  organizationId: string;
  principalId: string;
  expiresAt: number;
}

const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Gibt MCP-Zugangstokens aus und prüft sie — die „Eintrittskarte" zum Server,
 * strikt getrennt vom DATEV-OAuth.
 */
export class McpAccessTokenIssuer {
  /**
   * @param filePath - Ablagedatei (0600) für die Token-Hashes.
   * @param ttlMs - Lebensdauer neu ausgegebener Tokens.
   */
  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {}

  private read(): TokenFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as TokenFile;
      if (parsed.version === 1 && Array.isArray(parsed.tokens)) {
        return parsed;
      }
    } catch {
      // Fehlt/beschädigt — leere Ablage.
    }
    return { version: 1, tokens: [] };
  }

  private write(file: TokenFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, JSON.stringify(file, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  private prune(file: TokenFile, now: number): void {
    file.tokens = file.tokens.filter((record) => record.expiresAt > now);
  }

  /**
   * Stellt ein neues Zugangstoken für einen Nutzer-Slot aus.
   *
   * @returns Das Token (nur dieser Rückgabewert enthält es im Klartext —
   *   gespeichert wird ausschließlich der Hash) und seine Ablaufzeit.
   */
  issue(slot: string): { token: string; expiresAt: number } {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + this.ttlMs;

    const file = this.read();
    this.prune(file, now);
    file.tokens.push({
      tokenHash: hashToken(token),
      slot,
      createdAt: now,
      expiresAt,
    });
    this.write(file);
    return { token, expiresAt };
  }

  /**
   * Prüft ein vorgelegtes Token.
   *
   * @returns Kanzlei/Nutzer und Ablaufzeit bei gültigem, nicht abgelaufenem
   *   Token — sonst `undefined`. Der Vergleich läuft über den Hash in
   *   konstanter Zeit.
   */
  verify(token: string): VerifiedPrincipal | undefined {
    if (!token.startsWith(TOKEN_PREFIX)) {
      return undefined;
    }
    const now = Date.now();
    const presented = Buffer.from(hashToken(token), 'hex');

    for (const record of this.read().tokens) {
      const stored = Buffer.from(record.tokenHash, 'hex');
      if (
        stored.length === presented.length &&
        crypto.timingSafeEqual(stored, presented) &&
        record.expiresAt > now
      ) {
        const [organizationId, principalId] = record.slot.split('|');
        if (!organizationId || !principalId) {
          return undefined;
        }
        return { organizationId, principalId, expiresAt: record.expiresAt };
      }
    }
    return undefined;
  }

  /**
   * Widerruft ein einzelnes Token (z. B. Logout eines Geräts).
   *
   * @returns `true`, wenn ein Eintrag entfernt wurde.
   */
  revoke(token: string): boolean {
    const file = this.read();
    const before = file.tokens.length;
    const target = hashToken(token);
    file.tokens = file.tokens.filter((record) => record.tokenHash !== target);
    this.prune(file, Date.now());
    this.write(file);
    return file.tokens.length < before;
  }

  /**
   * Widerruft alle Tokens eines Nutzer-Slots (Offboarding).
   *
   * @returns Anzahl der entfernten Tokens.
   */
  revokeAllFor(slot: string): number {
    const file = this.read();
    const before = file.tokens.length;
    file.tokens = file.tokens.filter((record) => record.slot !== slot);
    this.prune(file, Date.now());
    this.write(file);
    return before - file.tokens.length;
  }
}
