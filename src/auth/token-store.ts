/**
 * Persistiert die DATEV-Tokens lokal als Datei.
 *
 * Der Speicherort liegt standardmäßig unter `~/.datev-mcp/` und wird bewusst
 * mit restriktiven Dateirechten (0600) geschrieben — die Tokens sind so
 * schützenswert wie ein Passwort. Die Tokens verlassen den Rechner nie; nur
 * die Antworten der Tools gehen an Claude.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Gespeicherter Anmeldezustand — Ergebnis eines erfolgreichen OAuth-Flows. */
export interface StoredTokens {
  /** Kurzlebiges Zugriffstoken für API-Aufrufe. */
  accessToken: string;
  /** Langlebiges Refresh-Token (~2 Jahre) zum Erneuern des Zugriffstokens. */
  refreshToken?: string;
  /** Unix-Millisekunden, zu denen das Zugriffstoken abläuft. */
  expiresAt: number;
  /** Tatsächlich gewährte Scopes (informativ). */
  scope?: string;
}

/** Datei-basierter Token-Speicher (eine Datei je Umgebung). */
export class FileTokenStore {
  /** @param filePath - Absoluter Pfad der Token-Datei. */
  constructor(private readonly filePath: string) {}

  /**
   * Liest die gespeicherten Tokens.
   *
   * @returns Die Tokens oder `undefined`, wenn keine Datei existiert oder ihr
   *   Inhalt beschädigt/unvollständig ist (defensive Prüfung, kein Wurf).
   */
  load(): StoredTokens | undefined {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredTokens;
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Schreibt die Tokens atomar mit restriktiven Rechten.
   *
   * @param tokens - Die zu speichernden Tokens.
   * @remarks Verzeichnis wird mit 0700 angelegt. Geschrieben wird zunächst in
   *   eine temporäre Datei (0600), die anschließend über {@link fs.renameSync}
   *   an ihren Platz gesetzt wird — so kann ein Abbruch mitten im Schreiben die
   *   bestehende (gültige) Token-Datei nicht beschädigen und das langlebige
   *   Refresh-Token geht nicht verloren. Abschließend werden die Rechte per
   *   `chmod` auf 0600 erzwungen, falls die Zieldatei mit lockeren Rechten
   *   vorbestand.
   */
  save(tokens: StoredTokens): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    // Exklusiv anlegen ('wx'): schlägt fehl, falls die Temp-Datei bereits
    // existiert (z. B. Symlink eines Angreifers) — so folgen wir keiner
    // vorhandenen Datei/Verknüpfung. Reste eines abgebrochenen Laufs vorher
    // entfernen.
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, JSON.stringify(tokens, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  /** Löscht die Token-Datei (z. B. beim Abmelden oder bei `invalid_grant`). */
  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Datei existiert nicht — nichts zu tun.
    }
  }
}
