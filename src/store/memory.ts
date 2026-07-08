import type { DatevDataset } from '../parser/types.js';

export interface DatasetSummary {
  key: string;
  clientNumber: string;
  clientName?: string;
  dateFrom: string;
  dateTo: string;
  bookingCount: number;
  active: boolean;
}

class InMemoryDatevStore {
  private readonly datasets = new Map<string, DatevDataset>();
  private activeKey?: string;

  /** Legt einen Datensatz ab und macht ihn zum aktiven Datensatz. */
  set(dataset: DatevDataset, key: string = dataset.filePath): void {
    this.datasets.set(key, dataset);
    this.activeKey = key;
  }

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

  activate(key: string): DatevDataset {
    const dataset = this.datasets.get(key);
    if (!dataset) {
      throw new Error(`Kein Datensatz mit dem Schlüssel "${key}" geladen.`);
    }
    this.activeKey = key;
    return dataset;
  }

  list(): DatasetSummary[] {
    return [...this.datasets.entries()].map(([key, dataset]) => ({
      key,
      clientNumber: dataset.header.clientNumber,
      clientName: dataset.header.clientName,
      dateFrom: dataset.header.dateFrom,
      dateTo: dataset.header.dateTo,
      bookingCount: dataset.bookings.length,
      active: key === this.activeKey
    }));
  }

  clear(): void {
    this.datasets.clear();
    this.activeKey = undefined;
  }
}

export const datevStore = new InMemoryDatevStore();
