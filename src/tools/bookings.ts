/**
 * Tool `list_bookings`: filtert Buchungen des aktiven Datensatzes.
 *
 * @remarks
 * Alle Filterkriterien sind optional und werden UND-verknüpft. Ein `account`
 * trifft sowohl auf das Konto als auch auf das Gegenkonto zu; `text` sucht im
 * Buchungstext und in den Belegfeldern.
 */
import { z } from 'zod';
import type { BookingFilter } from '../parser/types.js';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: Konto, Zeitraum, Mindestbetrag und Volltext (alle optional). */
export const listBookingsSchema = {
  account: z
    .string()
    .regex(/^\d+$/, 'Kontonummer besteht nur aus Ziffern')
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Von-Datum als ISO-Datum JJJJ-MM-TT')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Bis-Datum als ISO-Datum JJJJ-MM-TT')
    .optional(),
  minAmount: z.number().optional(),
  text: z.string().max(200).optional(),
};

/** Prüft, ob eine Buchung alle gesetzten Filterkriterien erfüllt. */
const matchesFilter = (
  filter: BookingFilter,
  booking: ReturnType<typeof datevStore.get>['bookings'][number]
): boolean => {
  if (
    filter.account &&
    booking.account !== filter.account &&
    booking.contraAccount !== filter.account
  ) {
    return false;
  }

  if (filter.from && booking.bookingDate < filter.from) {
    return false;
  }

  if (filter.to && booking.bookingDate > filter.to) {
    return false;
  }

  if (
    typeof filter.minAmount === 'number' &&
    booking.amount < filter.minAmount
  ) {
    return false;
  }

  if (filter.text) {
    const haystack = [
      booking.bookingText,
      booking.documentField1,
      booking.documentField2,
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filter.text.toLowerCase())) {
      return false;
    }
  }

  return true;
};

/**
 * Liefert die gefilterten Buchungen, aufsteigend nach Buchungsdatum.
 *
 * @param filter - Filterkriterien ({@link BookingFilter}).
 * @returns Anzahl und Liste der passenden Buchungen (auf die für Fragen
 *   relevanten Felder reduziert).
 */
export const listBookings = (filter: BookingFilter) => {
  const dataset = datevStore.get();
  const items = dataset.bookings
    .filter((booking) => matchesFilter(filter, booking))
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
