import { z } from 'zod';
import { parseDatevExtfFile } from '../parser/extf.js';
import { datevStore } from '../store/memory.js';

export const loadDatevFileSchema = {
  path: z.string().min(1)
};

export const loadDatevFile = ({ path }: { path: string }) => {
  const dataset = parseDatevExtfFile(path);
  datevStore.set(dataset);

  return {
    clientNumber: dataset.header.clientNumber,
    clientName: dataset.header.clientName ?? null,
    advisorNumber: dataset.header.advisorNumber,
    fiscalYearStart: dataset.header.fiscalYearStart,
    accountFramework: dataset.header.accountFramework,
    accountLength: dataset.header.accountLength,
    dateRange: {
      from: dataset.header.dateFrom,
      to: dataset.header.dateTo
    },
    bookingCount: dataset.bookings.length,
    summary: `Mandant ${dataset.header.clientNumber}${dataset.header.clientName ? ` (${dataset.header.clientName})` : ''}, Zeitraum ${dataset.header.dateFrom} bis ${dataset.header.dateTo}, ${dataset.bookings.length} Buchungen, Kontenrahmen ${dataset.header.accountFramework}`
  };
};
