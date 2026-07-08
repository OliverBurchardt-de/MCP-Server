/**
 * Tool `get_open_items`: listet offene Debitoren-/Kreditorenposten.
 *
 * @remarks
 * Offene Posten sind Buchungen auf Personenkonten (Kunden/Lieferanten), die als
 * offen markiert sind. Debitoren stehen für Forderungen (Kunde schuldet uns),
 * Kreditoren für Verbindlichkeiten (wir schulden dem Lieferanten).
 */
import { z } from 'zod';
import { getPersonAccountType } from '../parser/extf.js';
import type { OpenItem } from '../parser/types.js';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: optionale Filter nach Typ, Überfälligkeit und Stichtag. */
export const getOpenItemsSchema = {
  overdueOnly: z.boolean().optional(),
  type: z.enum(['debtor', 'creditor']).optional(),
  referenceDate: z.string().optional(),
};

/**
 * Ermittelt die offenen Posten des aktiven Datensatzes.
 *
 * @param overdueOnly - Wenn `true`, nur überfällige Posten.
 * @param type - Auf `debtor` oder `creditor` einschränken (optional).
 * @param referenceDate - Stichtag für „überfällig"; Standard ist heute.
 * @returns Anzahl und Liste der offenen Posten, nach Buchungsdatum sortiert.
 */
export const getOpenItems = ({
  overdueOnly,
  type,
  referenceDate,
}: {
  overdueOnly?: boolean;
  type?: 'debtor' | 'creditor';
  referenceDate?: string;
}) => {
  const dataset = datevStore.get();
  const today = referenceDate ?? new Date().toISOString().slice(0, 10);

  const items = dataset.bookings
    .map<OpenItem | null>((booking) => {
      // Nur offene Posten auf Personenkonten sind relevant; alles andere fällt raus.
      const accountType = getPersonAccountType(booking.account);
      if (!booking.isOpenItem || !accountType) {
        return null;
      }

      const overdue = Boolean(booking.dueDate && booking.dueDate < today);
      return {
        account: booking.account,
        accountType,
        amount: booking.direction === 'S' ? booking.amount : -booking.amount,
        dueDate: booking.dueDate,
        bookingDate: booking.bookingDate,
        bookingText: booking.bookingText,
        documentField1: booking.documentField1,
        documentField2: booking.documentField2,
        overdue,
      };
    })
    .filter((item): item is OpenItem => item !== null)
    .filter((item) => (type ? item.accountType === type : true))
    .filter((item) => (overdueOnly ? item.overdue : true))
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate));

  return {
    count: items.length,
    items,
  };
};
