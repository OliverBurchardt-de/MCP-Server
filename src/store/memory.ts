/**
 * Kontextgebundener In-Memory-Speicher für geladene DATEV-Datensätze.
 *
 * Seit dem Mehrbenutzer-Umbau (Phase 1) ist der Speicher nicht mehr
 * prozessglobal, sondern **kanzlei- und nutzergebunden**:
 *
 * - Datensätze gehören der **Kanzlei** (`organizationId`) — Mitarbeitende
 *   derselben Kanzlei teilen sich geladene Daten (einmal laden genügt).
 * - Der „aktive Datensatz" ist **pro Nutzer** (`principalId`) — zwei
 *   Mitarbeitende können gleichzeitig verschiedene Mandanten befragen, ohne
 *   sich gegenseitig den aktiven Datensatz zu verstellen.
 * - Jeder Zugriff prüft die **Mandanten-Allowlist** des Kontexts: Ein Nutzer,
 *   für den ein DATEV-Mandant nicht freigegeben ist, kann dessen Datensätze
 *   weder lesen noch in Listen/Fehlermeldungen sehen.
 *
 * Bewusst keine Datenbank: Die Daten bleiben nur im laufenden Prozess und
 * verlassen den Rechner nicht.
 */
import type { RequestContext } from '../context/context.js';
import type { DatevDataset } from '../parser/types.js';

/** Kurzüberblick eines geladenen Datensatzes (für `datev_status`). */
export interface DatasetSummary {
  /** Store-Schlüssel (Dateipfad oder `clientId:fiscalYearId`). */
  key: string;
  clientNumber: string;
  clientName?: string;
  dateFrom: string;
  dateTo: string;
  bookingCount: number;
  /** `true`, wenn der Datensatz vollständig geladen wurde. */
  complete: boolean;
  /** `true`, wenn dies der aktive Datensatz DES ANFRAGENDEN NUTZERS ist. */
  active: boolean;
}

/**
 * Liefert eine Warnung, wenn der Datensatz **unvollständig** ist (abgeschnitten
 * oder mit nicht lesbaren Zeilen) — sonst `undefined`.
 *
 * @remarks Wird von den Analyse-Tools an die Antwort gehängt, damit ein
 *   Teilbestand nie als vollständig erscheint.
 */
export const datasetWarning = (dataset: DatevDataset): string | undefined => {
  const p = dataset.provenance;
  if (p.complete) {
    return undefined;
  }
  const parts: string[] = [];
  if (p.truncated) {
    parts.push(
      `Menge abgeschnitten (${p.loadedCount}${p.totalCount ? ` von ${p.totalCount}` : ''} Zeilen geladen)`
    );
  }
  if (p.parseErrors > 0) {
    parts.push(`${p.parseErrors} Zeile(n) nicht lesbar`);
  }
  return `ACHTUNG: Datensatz UNVOLLSTÄNDIG (${parts.join('; ')}). Ergebnisse können unvollständig sein — dies dem Nutzer mitteilen.`;
};

/** Intern gespeicherter Eintrag: Datensatz plus Eigentums-/Herkunftsdaten. */
interface StoredDataset {
  dataset: DatevDataset;
  /** DATEV-Mandant (clientId), falls aus der Cloud geladen — für die Allowlist. */
  clientId?: string;
  /** Wer den Datensatz geladen hat (Nachvollziehbarkeit). */
  loadedBy: string;
}

/**
 * Verwaltet geladene Datensätze kanzlei-gebunden mit nutzer-eigenem aktiven
 * Datensatz und serverseitiger Mandanten-Autorisierung.
 */
class DatasetRepository {
  /** Datensätze je Kanzlei: organizationId → (Schlüssel → Eintrag). */
  private readonly byOrganization = new Map<
    string,
    Map<string, StoredDataset>
  >();

  /** Aktiver Schlüssel je Nutzer: `organizationId|principalId` → Schlüssel. */
  private readonly activeKeyByPrincipal = new Map<string, string>();

  private principalSlot(ctx: RequestContext): string {
    return `${ctx.organizationId}|${ctx.principalId}`;
  }

  private organizationDatasets(
    ctx: RequestContext
  ): Map<string, StoredDataset> {
    let datasets = this.byOrganization.get(ctx.organizationId);
    if (!datasets) {
      datasets = new Map();
      this.byOrganization.set(ctx.organizationId, datasets);
    }
    return datasets;
  }

  /** `true`, wenn der Kontext den Eintrag laut Mandanten-Allowlist sehen darf. */
  private visibleTo(ctx: RequestContext, entry: StoredDataset): boolean {
    if (!ctx.allowedClients || entry.clientId === undefined) {
      return true;
    }
    return ctx.allowedClients.has(entry.clientId);
  }

  /**
   * Legt einen Datensatz für die Kanzlei ab und macht ihn zum aktiven
   * Datensatz **des anfragenden Nutzers**.
   *
   * @param ctx - Anfrage-Kontext (bestimmt Kanzlei und Nutzer).
   * @param dataset - Der zu speichernde Datensatz.
   * @param key - Store-Schlüssel; Standard ist der `filePath` des Datensatzes.
   * @param meta.clientId - DATEV-Mandant, falls aus der Cloud geladen — wird
   *   für die Mandanten-Allowlist ausgewertet.
   */
  set(
    ctx: RequestContext,
    dataset: DatevDataset,
    key: string = dataset.filePath,
    meta: { clientId?: string } = {}
  ): void {
    this.organizationDatasets(ctx).set(key, {
      dataset,
      clientId: meta.clientId,
      loadedBy: ctx.principalId,
    });
    this.activeKeyByPrincipal.set(this.principalSlot(ctx), key);
  }

  /**
   * Liefert einen geladenen Datensatz der eigenen Kanzlei.
   *
   * @param ctx - Anfrage-Kontext; Zugriffe sind auf die eigene Kanzlei und die
   *   Mandanten-Allowlist des Nutzers beschränkt.
   * @param key - Optionaler Store-Schlüssel (`clientId:fiscalYearId` bzw.
   *   Dateipfad), um **gezielt** einen bestimmten Datensatz anzusprechen statt
   *   des eigenen aktiven.
   * @throws Error - wenn noch nichts geladen wurde, der Schlüssel nicht
   *   existiert (Fehlermeldung nennt nur für DIESEN Nutzer sichtbare
   *   Schlüssel) oder die Mandanten-Allowlist den Zugriff verbietet.
   */
  get(ctx: RequestContext, key?: string): DatevDataset {
    const datasets = this.organizationDatasets(ctx);
    const targetKey =
      key ?? this.activeKeyByPrincipal.get(this.principalSlot(ctx));
    if (!targetKey) {
      throw new Error(
        'Keine Daten geladen. Zuerst load_datev_file (Exportdatei) oder datev_load_from_cloud (Live-Daten) ausführen.'
      );
    }

    const entry = datasets.get(targetKey);
    if (!entry || !this.visibleTo(ctx, entry)) {
      if (key) {
        const available = [...datasets.entries()]
          .filter(([, candidate]) => this.visibleTo(ctx, candidate))
          .map(([candidateKey]) => candidateKey);
        throw new Error(
          `Kein Datensatz "${key}" geladen. Verfügbar: ${available.length ? available.join(', ') : '(keiner)'}. Bitte zuerst laden oder einen der verfügbaren Schlüssel angeben.`
        );
      }
      throw new Error('Der aktive Datensatz existiert nicht mehr.');
    }

    return entry.dataset;
  }

  /**
   * Wählt einen bereits geladenen Datensatz als aktiven Datensatz des
   * anfragenden Nutzers aus.
   *
   * @throws Error - wenn der Schlüssel nicht existiert oder nicht sichtbar ist.
   */
  activate(ctx: RequestContext, key: string): DatevDataset {
    const entry = this.organizationDatasets(ctx).get(key);
    if (!entry || !this.visibleTo(ctx, entry)) {
      throw new Error(`Kein Datensatz mit dem Schlüssel "${key}" geladen.`);
    }
    this.activeKeyByPrincipal.set(this.principalSlot(ctx), key);
    return entry.dataset;
  }

  /**
   * Kurzüberblicke der für DIESEN Nutzer sichtbaren Datensätze seiner Kanzlei.
   *
   * @remarks Datensätze fremder Kanzleien oder nicht freigegebener Mandanten
   *   erscheinen nicht — auch nicht als Schlüssel.
   */
  list(ctx: RequestContext): DatasetSummary[] {
    const activeKey = this.activeKeyByPrincipal.get(this.principalSlot(ctx));
    return [...this.organizationDatasets(ctx).entries()]
      .filter(([, entry]) => this.visibleTo(ctx, entry))
      .map(([key, entry]) => ({
        key,
        clientNumber: entry.dataset.header.clientNumber,
        clientName: entry.dataset.header.clientName,
        dateFrom: entry.dataset.header.dateFrom,
        dateTo: entry.dataset.header.dateTo,
        bookingCount: entry.dataset.bookings.length,
        complete: entry.dataset.provenance.complete,
        active: key === activeKey,
      }));
  }

  /**
   * Entfernt Datensätze.
   *
   * @param ctx - Ohne Kontext (nur Tests) wird ALLES geleert; mit Kontext nur
   *   die eigene Kanzlei samt der aktiven Verweise ihrer Nutzer.
   */
  clear(ctx?: RequestContext): void {
    if (!ctx) {
      this.byOrganization.clear();
      this.activeKeyByPrincipal.clear();
      return;
    }
    this.byOrganization.delete(ctx.organizationId);
    for (const slot of [...this.activeKeyByPrincipal.keys()]) {
      if (slot.startsWith(`${ctx.organizationId}|`)) {
        this.activeKeyByPrincipal.delete(slot);
      }
    }
  }
}

/** Prozessweit gemeinsam genutzte Speicher-Instanz (Zugriff stets per Kontext). */
export const datevStore = new DatasetRepository();
