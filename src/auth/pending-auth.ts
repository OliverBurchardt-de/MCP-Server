/**
 * Persistente Einmal-Ablage für laufende OAuth-Anmeldevorgänge (Phase 2).
 *
 * Für den Remote-Betrieb (öffentlicher HTTPS-Callback, Phase 3) muss der
 * Server einen eingehenden Callback dem richtigen Nutzer und Anmeldevorgang
 * zuordnen können — auch nach einem Prozess-Neustart. Diese Ablage speichert
 * je Vorgang `state` (Zuordnungsschlüssel), PKCE-`verifier`, den Nutzer-Slot
 * und eine Ablaufzeit. Jeder Vorgang ist **einmalig konsumierbar**: Der erste
 * Callback verbraucht ihn, Wiederholungen (Replay) und abgelaufene oder
 * fremde States laufen ins Leere.
 *
 * @remarks Der lokale Loopback-Flow behält seinen In-Memory-Zustand (er lebt
 *   nur Sekunden im selben Prozess). Diese Ablage ist der Baustein für den
 *   `RemoteDatevOAuthController` der Phase 3.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPkcePair, createState } from './oauth.js';

/** Ein wartender Anmeldevorgang. */
export interface PendingAuthorization {
  /** OAuth-`state` — ordnet den Callback diesem Vorgang zu. */
  state: string;
  /** PKCE-Code-Verifier für den Token-Austausch. */
  verifier: string;
  /** Nutzer-Slot (`organizationId|principalId`), dem die Tokens gehören. */
  slot: string;
  /** Unix-Millisekunden der Erstellung. */
  createdAt: number;
  /** Unix-Millisekunden, ab denen der Vorgang verfällt. */
  expiresAt: number;
}

/** Standard-Lebensdauer eines Anmeldevorgangs (10 Minuten, wie der Loopback). */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Dateiformat der Ablage. */
interface PendingFile {
  version: 1;
  pending: Record<string, PendingAuthorization>;
}

/** Persistente, einmalig konsumierbare Ablage für OAuth-Anmeldevorgänge. */
export class PendingAuthorizationStore {
  /** @param filePath - Ablagedatei (0600; enthält kurzlebige Geheimnisse). */
  constructor(private readonly filePath: string) {}

  private read(): PendingFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as PendingFile;
      if (parsed.version === 1 && parsed.pending) {
        return parsed;
      }
    } catch {
      // Fehlt/beschädigt — leere Ablage.
    }
    return { version: 1, pending: {} };
  }

  private write(file: PendingFile): void {
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

  /** Entfernt abgelaufene Vorgänge (wird bei jedem Zugriff mitgepflegt). */
  private prune(file: PendingFile, now: number): void {
    for (const [state, entry] of Object.entries(file.pending)) {
      if (entry.expiresAt <= now) {
        delete file.pending[state];
      }
    }
  }

  /**
   * Startet einen neuen Anmeldevorgang für einen Nutzer-Slot.
   *
   * @returns `state` (für die Authorize-URL und die Callback-Zuordnung) und
   *   die PKCE-`challenge` (S256) für die Authorize-URL. Der `verifier` bleibt
   *   ausschließlich serverseitig in der Ablage.
   */
  begin(
    slot: string,
    ttlMs: number = DEFAULT_TTL_MS
  ): { state: string; challenge: string } {
    const state = createState();
    const { verifier, challenge } = createPkcePair();
    const now = Date.now();

    const file = this.read();
    this.prune(file, now);
    file.pending[state] = {
      state,
      verifier,
      slot,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.write(file);
    return { state, challenge };
  }

  /**
   * Konsumiert einen Vorgang **genau einmal**.
   *
   * @returns Den Vorgang, wenn der `state` existiert und nicht abgelaufen ist —
   *   der Eintrag wird dabei entfernt (Replay-Schutz). Sonst `undefined`.
   */
  consume(state: string): PendingAuthorization | undefined {
    const now = Date.now();
    const file = this.read();
    this.prune(file, now);
    const entry = file.pending[state];
    delete file.pending[state];
    this.write(file);
    return entry;
  }

  /** Anzahl aktuell wartender (nicht abgelaufener) Vorgänge. */
  count(): number {
    const file = this.read();
    this.prune(file, Date.now());
    return Object.keys(file.pending).length;
  }
}
