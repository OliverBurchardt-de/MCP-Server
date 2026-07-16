/**
 * Prozessweiter In-Memory-Speicher für geladene DATEV-Datensätze.
 *
 * Hält mehrere Datensätze gleichzeitig (verschiedene Dateien und/oder
 * Cloud-Wirtschaftsjahre) und merkt sich den „aktiven" Datensatz, auf den sich
 * die Analyse-Tools ohne weitere Parameter beziehen. Bewusst keine Datenbank:
 * Die Daten bleiben nur im laufenden Prozess und verlassen den Rechner nicht.
 */
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
  /** `true`, wenn dies der aktuell aktive Datensatz ist. */
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

/** Verwaltet die geladenen Datensätze und den aktiven Datensatz. */
class InMemoryDatevStore {
  private readonly datasets = new Map<string, DatevDataset>();
  private activeKey?: string;

  /**
   * Legt einen Datensatz ab und macht ihn zum aktiven Datensatz.
   *
   * @param dataset - Der zu speichernde Datensatz.
   * @param key - Store-Schlüssel; Standard ist der `filePath` des Datensatzes.
   */
  set(dataset: DatevDataset, key: string = dataset.filePath): void {
    this.datasets.set(key, dataset);
    this.activeKey = key;
  }

  /**
   * Liefert den aktiven Datensatz.
   *
   * @throws Error - wenn noch nichts geladen wurde (mit Hinweis auf die
   *   Lade-Tools) oder der aktive Datensatz nicht mehr existiert.
   */
  get(): DatevDataset {
    if (!this.activeKey) {
      throw new Error(
        'Keine Daten geladen. Zuerst load_datev_file (Exportdatei) oder datev_load_from_cloud (Live-Daten) ausführen.'
      );
    }

    const dataset = this.datasets.get(this.activeKey);
    if (!dataset) {
      throw new Error('Der aktive Datensatz existiert nicht mehr.');
    }

    return dataset;
  }

  /**
   * Wählt einen bereits geladenen Datensatz als aktiven aus.
   *
   * @param key - Store-Schlüssel des Datensatzes.
   * @throws Error - wenn kein Datensatz mit diesem Schlüssel geladen ist.
   */
  activate(key: string): DatevDataset {
    const dataset = this.datasets.get(key);
    if (!dataset) {
      throw new Error(`Kein Datensatz mit dem Schlüssel "${key}" geladen.`);
    }
    this.activeKey = key;
    return dataset;
  }

  /** Liefert Kurzüberblicke aller geladenen Datensätze. */
  list(): DatasetSummary[] {
    return [...this.datasets.entries()].map(([key, dataset]) => ({
      key,
      clientNumber: dataset.header.clientNumber,
      clientName: dataset.header.clientName,
      dateFrom: dataset.header.dateFrom,
      dateTo: dataset.header.dateTo,
      bookingCount: dataset.bookings.length,
      complete: dataset.provenance.complete,
      active: key === this.activeKey,
    }));
  }

  /** Entfernt alle Datensätze (z. B. für Tests). */
  clear(): void {
    this.datasets.clear();
    this.activeKey = undefined;
  }
}

/** Prozessweit gemeinsam genutzte Speicher-Instanz. */
export const datevStore = new InMemoryDatevStore();
