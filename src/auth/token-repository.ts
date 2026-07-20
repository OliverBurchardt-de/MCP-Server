/**
 * Verschlüsselte, mehrbenutzerfähige Token-Ablage (Phase 2 des Remote-Umbaus).
 *
 * Ersetzt für den Serverbetrieb die einzelne Klartext-Token-Datei: Die
 * DATEV-Tokens **aller** Nutzer liegen in einer Datei, je Nutzer-Slot
 * (`organizationId|principalId`) einzeln mit **AES-256-GCM** verschlüsselt.
 * Der Schlüssel kommt aus `DATEV_TOKEN_KEY` (Base64, 32 Bytes) oder wird beim
 * ersten Start als Schlüsseldatei (0600) neben der Ablage erzeugt.
 *
 * @remarks
 * - **Migration:** Findet ein Slot keine Tokens, wird einmalig die alte
 *   Klartext-Datei (`tokens-<env>.json`) importiert und danach gelöscht — der
 *   bestehende lokale Login bleibt so ohne Neu-Anmeldung erhalten, aber es
 *   bleibt kein Klartext-Token auf der Platte zurück.
 * - Die GCM-Authentifizierung (Auth-Tag) erkennt Manipulationen an der Datei;
 *   ein manipulierter Eintrag liefert `undefined` statt falscher Tokens.
 * - Grenze des Verfahrens: Der Schlüssel liegt (ohne `DATEV_TOKEN_KEY` aus
 *   einem Secret Store) als Datei auf derselben Maschine. Das schützt gegen
 *   Backup-/Kopier-Abfluss der Token-Datei, nicht gegen einen Angreifer mit
 *   vollem Konto-Zugriff — für den Serverbetrieb wird der Schlüssel deshalb
 *   per Umgebungsvariable aus einem Secret Store injiziert (siehe
 *   BETRIEB-REMOTE-BRIEFING).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestContext } from '../context/context.js';
import { FileTokenStore, type StoredTokens } from './token-store.js';

/** Schnittstelle, die {@link TokenManager} vom Speicher erwartet. */
export interface TokenStoreLike {
  load(): StoredTokens | undefined;
  save(tokens: StoredTokens): void;
  clear(): void;
}

/** Ein verschlüsselter Eintrag der Ablage (alles Base64). */
interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

/** Dateiformat der Ablage. */
interface RepositoryFile {
  version: 2;
  entries: Record<string, EncryptedEntry>;
}

/** Slot-Schlüssel eines Kontexts: Kanzlei + Nutzer. */
export const tokenSlot = (ctx: RequestContext): string =>
  `${ctx.organizationId}|${ctx.principalId}`;

/**
 * Mehrbenutzerfähige Token-Ablage mit Verschlüsselung ruhender Daten.
 */
export class EncryptedTokenRepository {
  private readonly key: Buffer;

  /**
   * @param filePath - Pfad der verschlüsselten Ablage (z. B. `tokens-sandbox.v2.json`).
   * @param options.keyBase64 - Schlüssel aus der Umgebung (`DATEV_TOKEN_KEY`,
   *   Base64, 32 Bytes). Ohne Angabe wird eine Schlüsseldatei neben der Ablage
   *   verwendet bzw. beim ersten Start erzeugt (0600).
   * @param options.legacyPath - Pfad der alten Klartext-Token-Datei für die
   *   einmalige Migration.
   */
  constructor(
    private readonly filePath: string,
    private readonly options: { keyBase64?: string; legacyPath?: string } = {}
  ) {
    this.key = this.resolveKey();
  }

  private resolveKey(): Buffer {
    if (this.options.keyBase64) {
      const key = Buffer.from(this.options.keyBase64, 'base64');
      if (key.length !== 32) {
        throw new Error(
          'DATEV_TOKEN_KEY muss ein Base64-kodierter 32-Byte-Schlüssel sein.'
        );
      }
      return key;
    }

    const keyPath = path.join(path.dirname(this.filePath), 'token-key');
    try {
      const existing = Buffer.from(
        fs.readFileSync(keyPath, 'utf8').trim(),
        'base64'
      );
      if (existing.length === 32) {
        return existing;
      }
    } catch {
      // Keine Schlüsseldatei — unten neu erzeugen.
    }

    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const fresh = crypto.randomBytes(32);
    const tempPath = `${keyPath}.${process.pid}.tmp`;
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, fresh.toString('base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, keyPath);
    fs.chmodSync(keyPath, 0o600);
    return fresh;
  }

  private readFile(): RepositoryFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as RepositoryFile;
      if (parsed.version === 2 && parsed.entries) {
        return parsed;
      }
    } catch {
      // Fehlt/beschädigt — leere Ablage.
    }
    return { version: 2, entries: {} };
  }

  private writeFile(file: RepositoryFile): void {
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

  private encrypt(tokens: StoredTokens): EncryptedEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(tokens), 'utf8'),
      cipher.final(),
    ]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  private decrypt(entry: EncryptedEntry): StoredTokens | undefined {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(entry.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plain) as StoredTokens;
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      // Falscher Schlüssel oder manipulierter Eintrag (Auth-Tag schlägt fehl).
      return undefined;
    }
  }

  /** Liest die Tokens eines Slots (inkl. einmaliger Klartext-Migration). */
  load(slot: string): StoredTokens | undefined {
    const entry = this.readFile().entries[slot];
    if (entry) {
      return this.decrypt(entry);
    }
    return this.migrateLegacy(slot);
  }

  /**
   * Einmalige Übernahme der alten Klartext-Datei in den anfragenden Slot.
   * Nach erfolgreichem Import wird die Klartext-Datei gelöscht.
   */
  private migrateLegacy(slot: string): StoredTokens | undefined {
    const legacyPath = this.options.legacyPath;
    if (!legacyPath || !fs.existsSync(legacyPath)) {
      return undefined;
    }
    const legacy = new FileTokenStore(legacyPath).load();
    if (!legacy) {
      return undefined;
    }
    this.save(slot, legacy);
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // Löschen ist Best Effort — die verschlüsselte Kopie existiert bereits.
    }
    return legacy;
  }

  /** Speichert die Tokens eines Slots (verschlüsselt, atomar). */
  save(slot: string, tokens: StoredTokens): void {
    const file = this.readFile();
    file.entries[slot] = this.encrypt(tokens);
    this.writeFile(file);
  }

  /** Entfernt die Tokens eines Slots (Abmelden/Offboarding). */
  clear(slot: string): void {
    const file = this.readFile();
    if (slot in file.entries) {
      delete file.entries[slot];
      this.writeFile(file);
    }
  }

  /** Slots, für die aktuell Tokens hinterlegt sind (nur Kennungen, keine Tokens). */
  listSlots(): string[] {
    return Object.keys(this.readFile().entries);
  }

  /**
   * Sicht eines einzelnen Slots als einfacher Token-Store — die Schnittstelle,
   * die {@link TokenManager} erwartet.
   */
  storeFor(slot: string): TokenStoreLike {
    return {
      load: () => this.load(slot),
      save: (tokens) => this.save(slot, tokens),
      clear: () => this.clear(slot),
    };
  }
}
