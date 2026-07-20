/**
 * Tool `search_documents`: Volltextsuche über Buchungen.
 *
 * @remarks
 * Durchsucht Buchungstext sowie Belegfeld 1 und 2 (dort stehen typischerweise
 * Rechnungsnummern) nach einem Suchbegriff. Praktisch, um z. B. eine bestimmte
 * Rechnung anhand ihrer Nummer zu finden.
 */
import { z } from 'zod';
import type { RequestContext } from '../context/context.js';
import { datasetWarning, datevStore } from '../store/memory.js';

/** Obergrenze der zurückgegebenen Treffer (Kontext-Schutz). */
const MAX_RESULT_ROWS = 200;

/** Eingabeschema: der Suchbegriff (optional gezielter Datensatz). */
export const searchDocumentsSchema = {
  query: z.string().min(1),
  dataset: z
    .string()
    .optional()
    .describe(
      'Optionaler Datensatz-Schlüssel (clientId:fiscalYearId), um gezielt einen bestimmten geladenen Datensatz zu durchsuchen'
    ),
};

/**
 * Sucht Buchungen, deren Text/Belegfelder den Begriff enthalten.
 *
 * @param query - Suchbegriff (Groß-/Kleinschreibung wird ignoriert).
 * @returns Anzahl und Liste der Treffer, nach Buchungsdatum sortiert.
 */
export const searchDocuments = (
  ctx: RequestContext,
  {
    query,
    dataset: datasetKey,
  }: {
    query: string;
    dataset?: string;
  }
) => {
  const dataset = datevStore.get(ctx, datasetKey);
  const needle = query.toLowerCase();
  const matched = dataset.bookings
    .filter((booking) =>
      [booking.bookingText, booking.documentField1, booking.documentField2]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate));

  const items = matched.slice(0, MAX_RESULT_ROWS).map((booking) => ({
    bookingDate: booking.bookingDate,
    account: booking.account,
    contraAccount: booking.contraAccount,
    amount: booking.amount,
    direction: booking.direction,
    bookingText: booking.bookingText,
    documentField1: booking.documentField1,
    documentField2: booking.documentField2,
  }));

  const warnung = datasetWarning(dataset);
  return {
    count: matched.length,
    angezeigt: items.length,
    ...(warnung ? { datenstandWarnung: warnung } : {}),
    ...(matched.length > items.length
      ? {
          hinweis: 'Ausgabe gekürzt — bitte den Suchbegriff präzisieren.',
        }
      : {}),
    items,
  };
};
