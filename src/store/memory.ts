import type { DatevDataset } from '../parser/types.js';

class InMemoryDatevStore {
  private dataset?: DatevDataset;

  set(dataset: DatevDataset): void {
    this.dataset = dataset;
  }

  get(): DatevDataset {
    if (!this.dataset) {
      throw new Error('No DATEV file loaded. Use load_datev_file first.');
    }

    return this.dataset;
  }

  clear(): void {
    this.dataset = undefined;
  }
}

export const datevStore = new InMemoryDatevStore();
