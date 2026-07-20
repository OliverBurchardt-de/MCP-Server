/**
 * Nutzerverwaltung der Kanzlei (Phase 3 des Remote-Umbaus).
 *
 * Jede Mitarbeiterin/jeder Mitarbeiter bekommt ein **Konto** mit einem einmal
 * angezeigten **Zugangsschlüssel** (vom Kanzlei-Admin per CLI angelegt, siehe
 * `npm run add-user`). Bei der Anmeldung am Server (OAuth-Formular) weist man
 * sich mit diesem Schlüssel aus; gespeichert wird ausschließlich der
 * **SHA-256-Hash** — die Ablage enthält nie verwendbare Schlüssel.
 *
 * @remarks
 * - Konten können **gesperrt** werden (Offboarding): Der Schlüssel verliert
 *   sofort seine Wirkung; zusätzlich sollten die MCP-Tokens des Nutzers über
 *   {@link McpAccessTokenIssuer.revokeAllFor} widerrufen und die DATEV-Tokens
 *   über `datev_logout`/Repository-Clear entfernt werden.
 * - Optional trägt ein Konto eine **Mandanten-Allowlist**, die in den
 *   {@link RequestContext} übernommen und serverseitig durchgesetzt wird.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Ein Nutzerkonto der Kanzlei (ohne Schlüssel — nur dessen Hash). */
export interface PrincipalRecord {
  /** SHA-256-Hex des Zugangsschlüssels. */
  keyHash: string;
  principalId: string;
  organizationId: string;
  /** Optionale Mandanten-Allowlist (clientIds); leer/fehlend = keine Einschränkung. */
  allowedClients?: string[];
  createdAt: number;
  disabled?: boolean;
}

/** Dateiformat der Ablage. */
interface RegistryFile {
  version: 1;
  principals: PrincipalRecord[];
}

/** Erkennungs-Präfix der Zugangsschlüssel. */
const KEY_PREFIX = 'kzl_';

const hashKey = (key: string): string =>
  crypto.createHash('sha256').update(key, 'utf8').digest('hex');

/** Verwaltet die Nutzerkonten der Kanzlei (Datei 0600, nur Hashes). */
export class PrincipalRegistry {
  /** @param filePath - Ablagedatei der Konten. */
  constructor(private readonly filePath: string) {}

  private read(): RegistryFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as RegistryFile;
      if (parsed.version === 1 && Array.isArray(parsed.principals)) {
        return parsed;
      }
    } catch {
      // Fehlt/beschädigt — leere Ablage.
    }
    return { version: 1, principals: [] };
  }

  private write(file: RegistryFile): void {
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

  /**
   * Legt ein Nutzerkonto an und erzeugt dessen Zugangsschlüssel.
   *
   * @returns Den Zugangsschlüssel — er wird GENAU HIER einmal im Klartext
   *   zurückgegeben (dem Nutzer sicher übergeben); gespeichert wird nur der Hash.
   * @throws Error - wenn für Kanzlei+Nutzer bereits ein aktives Konto existiert.
   */
  add(account: {
    principalId: string;
    organizationId: string;
    allowedClients?: string[];
  }): { accessKey: string } {
    const file = this.read();
    const existing = file.principals.find(
      (record) =>
        record.principalId === account.principalId &&
        record.organizationId === account.organizationId &&
        !record.disabled
    );
    if (existing) {
      throw new Error(
        `Für "${account.organizationId}|${account.principalId}" existiert bereits ein aktives Konto. Zuerst sperren (disable), dann neu anlegen.`
      );
    }

    const accessKey = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    file.principals.push({
      keyHash: hashKey(accessKey),
      principalId: account.principalId,
      organizationId: account.organizationId,
      ...(account.allowedClients?.length
        ? { allowedClients: account.allowedClients }
        : {}),
      createdAt: Date.now(),
    });
    this.write(file);
    return { accessKey };
  }

  /**
   * Prüft einen vorgelegten Zugangsschlüssel (Konstantzeit über den Hash).
   *
   * @returns Das Konto (ohne Hash) bei gültigem, nicht gesperrtem Schlüssel —
   *   sonst `undefined`.
   */
  verify(
    accessKey: string
  ):
    | Pick<PrincipalRecord, 'principalId' | 'organizationId' | 'allowedClients'>
    | undefined {
    if (!accessKey.startsWith(KEY_PREFIX)) {
      return undefined;
    }
    const presented = Buffer.from(hashKey(accessKey), 'hex');
    for (const record of this.read().principals) {
      const stored = Buffer.from(record.keyHash, 'hex');
      if (
        stored.length === presented.length &&
        crypto.timingSafeEqual(stored, presented) &&
        !record.disabled
      ) {
        return {
          principalId: record.principalId,
          organizationId: record.organizationId,
          allowedClients: record.allowedClients,
        };
      }
    }
    return undefined;
  }

  /** Liefert ein Konto (z. B. für die Allowlist eines Bearer-Tokens). */
  get(
    principalId: string,
    organizationId: string
  ): PrincipalRecord | undefined {
    return this.read().principals.find(
      (record) =>
        record.principalId === principalId &&
        record.organizationId === organizationId &&
        !record.disabled
    );
  }

  /**
   * Sperrt ein Konto (Offboarding) — der Zugangsschlüssel wirkt sofort nicht mehr.
   *
   * @returns `true`, wenn ein aktives Konto gesperrt wurde.
   */
  disable(principalId: string, organizationId: string): boolean {
    const file = this.read();
    let changed = false;
    for (const record of file.principals) {
      if (
        record.principalId === principalId &&
        record.organizationId === organizationId &&
        !record.disabled
      ) {
        record.disabled = true;
        changed = true;
      }
    }
    if (changed) {
      this.write(file);
    }
    return changed;
  }

  /** Kontenübersicht ohne Geheimnisse (für die Verwaltung). */
  list(): Array<
    Pick<
      PrincipalRecord,
      'principalId' | 'organizationId' | 'createdAt' | 'disabled'
    >
  > {
    return this.read().principals.map(
      ({ principalId, organizationId, createdAt, disabled }) => ({
        principalId,
        organizationId,
        createdAt,
        disabled,
      })
    );
  }
}
