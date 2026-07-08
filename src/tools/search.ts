/**
 * Tool `search_documents`: Volltextsuche über Buchungen.
 *
 * @remarks
 * Durchsucht Buchungstext sowie Belegfeld 1 und 2 (dort stehen typischerweise
 * Rechnungsnummern) nach einem Suchbegriff. Praktisch, um z. B. eine bestimmte
 * Rechnung anhand ihrer Nummer zu finden.
 */
import { z } from 'zod';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: der Suchbegriff. */
export const searchDocumentsSchema = {
  query: z.string().min(1),
};

/**
 * Sucht Buchungen, deren Text/Belegfelder den Begriff enthalten.
 *
 * @param query - Suchbegriff (Groß-/Kleinschreibung wird ignoriert).
 * @returns Anzahl und Liste der Treffer, nach Buchungsdatum sortiert.
 */
export const searchDocuments = ({ query }: { query: string }) => {
  const dataset = datevStore.get();
  const needle = query.toLowerCase();
  const items = dataset.bookings
    .filter((booking) =>
      [booking.bookingText, booking.documentField1, booking.documentField2]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate))
    .map((booking) => ({
      bookingDate: booking.bookingDate,
      account: booking.account,
      contraAccount: booking.contraAccount,
      amount: booking.amount,
      direction: booking.direction,
      bookingText: booking.bookingText,
      documentField1: booking.documentField1,
      documentField2: booking.documentField2,
    }));

  return {
    count: items.length,
    items,
  };
};
