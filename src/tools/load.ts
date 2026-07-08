/**
 * Tool `load_datev_file`: lädt eine EXTF-Exportdatei in den Store.
 *
 * @remarks
 * Nach dem Laden ist der Datensatz aktiv; die Analyse-Tools beziehen sich
 * darauf. Die Rückgabe fasst Mandant, Zeitraum und Buchungsanzahl zusammen,
 * damit Claude dem Nutzer sofort bestätigen kann, was geladen wurde.
 */
import { z } from 'zod';
import { parseDatevExtfFile } from '../parser/extf.js';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: Pfad zur EXTF/DTVF-Datei. */
export const loadDatevFileSchema = {
  path: z.string().min(1),
};

/**
 * Lädt die Datei am angegebenen Pfad und legt sie als aktiven Datensatz ab.
 *
 * @param path - Absoluter oder relativer Pfad zur Exportdatei.
 * @returns Zusammenfassung des geladenen Datensatzes.
 */
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
      to: dataset.header.dateTo,
    },
    bookingCount: dataset.bookings.length,
    summary: `Mandant ${dataset.header.clientNumber}${dataset.header.clientName ? ` (${dataset.header.clientName})` : ''}, Zeitraum ${dataset.header.dateFrom} bis ${dataset.header.dateTo}, ${dataset.bookings.length} Buchungen, Kontenrahmen ${dataset.header.accountFramework}`,
  };
};
