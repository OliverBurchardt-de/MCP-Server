/**
 * Tool `get_open_items`: listet Posten auf Personenkonten (Debitoren/Kreditoren).
 *
 * @remarks
 * Debitoren stehen für Forderungen (Kunde schuldet uns), Kreditoren für
 * Verbindlichkeiten (wir schulden dem Lieferanten). Das Personenkonto kann in
 * einer Buchung sowohl das **Haupt-** als auch das **Gegenkonto** sein — z. B.
 * bei einer Eingangsrechnung „Soll Aufwand an Haben Kreditor" sitzt der
 * Lieferant auf dem Gegenkonto. Beide Seiten werden erkannt.
 *
 * Wichtige Einschränkung: Ein einzelner Buchungsstapel zeigt **Buchungen**, kein
 * periodenübergreifend abgeglichenes OPOS. Ob ein Posten wirklich noch offen
 * (unbezahlt) ist, ergibt sich erst aus dem OPOS/der Summen- und Saldenliste der
 * DATEV-Cloud. Die Ausgabe trägt daher einen entsprechenden Hinweis.
 */
import { z } from 'zod';
import { getPersonAccountType } from '../parser/extf.js';
import type { DatevBooking, OpenItem } from '../parser/types.js';
import { datevStore } from '../store/memory.js';

/** Obergrenze der zurückgegebenen Posten (Kontext-Schutz). */
const MAX_ITEMS = 200;

/** Eingabeschema: optionale Filter nach Typ, Überfälligkeit, Stichtag und Anzahl. */
export const getOpenItemsSchema = {
  overdueOnly: z.boolean().optional(),
  type: z.enum(['debtor', 'creditor']).optional(),
  referenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Stichtag als ISO-Datum JJJJ-MM-TT')
    .optional(),
  maxResults: z.number().int().min(1).max(MAX_ITEMS).optional(),
};

/**
 * Bestimmt das Personenkonto einer Buchung und den Betrag aus dessen Sicht.
 *
 * @remarks
 * Steht das Personenkonto im Gegenkonto, dreht sich die Soll/Haben-Richtung
 * (die Buchung betrifft das Konto dann spiegelbildlich). Vorzeichenkonvention:
 * Debitor-Forderung positiv, Kreditor-Verbindlichkeit negativ.
 */
const toPersonPosting = (
  booking: DatevBooking,
  today: string
): OpenItem | null => {
  const primaryType = getPersonAccountType(booking.account);
  const contraType = getPersonAccountType(booking.contraAccount);

  let account: string;
  let accountType: 'debtor' | 'creditor';
  let direction: 'S' | 'H';
  if (primaryType) {
    account = booking.account;
    accountType = primaryType;
    direction = booking.direction;
  } else if (contraType) {
    account = booking.contraAccount;
    accountType = contraType;
    direction = booking.direction === 'S' ? 'H' : 'S';
  } else {
    return null;
  }

  return {
    account,
    accountType,
    amount: direction === 'S' ? booking.amount : -booking.amount,
    dueDate: booking.dueDate,
    bookingDate: booking.bookingDate,
    bookingText: booking.bookingText,
    documentField1: booking.documentField1,
    documentField2: booking.documentField2,
    overdue: Boolean(booking.dueDate && booking.dueDate < today),
  };
};

/**
 * Ermittelt die Personenkonto-Posten des aktiven Datensatzes.
 *
 * @param overdueOnly - Wenn `true`, nur überfällige Posten (setzt Fälligkeit voraus).
 * @param type - Auf `debtor` oder `creditor` einschränken (optional).
 * @param referenceDate - Stichtag für „überfällig"; Standard ist heute.
 * @param maxResults - Obergrenze der ausgegebenen Posten (Standard {@link MAX_ITEMS}).
 * @returns Gesamt- und angezeigte Anzahl, ein Hinweis zur OPOS-Semantik und die
 *   nach Buchungsdatum sortierten Posten.
 */
export const getOpenItems = ({
  overdueOnly,
  type,
  referenceDate,
  maxResults,
}: {
  overdueOnly?: boolean;
  type?: 'debtor' | 'creditor';
  referenceDate?: string;
  maxResults?: number;
}) => {
  const dataset = datevStore.get();
  const today = referenceDate ?? new Date().toISOString().slice(0, 10);

  const all = dataset.bookings
    .map((booking) => toPersonPosting(booking, today))
    .filter((item): item is OpenItem => item !== null)
    .filter((item) => (type ? item.accountType === type : true))
    .filter((item) => (overdueOnly ? item.overdue : true))
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate));

  const items = all.slice(0, maxResults ?? MAX_ITEMS);

  return {
    count: all.length,
    angezeigt: items.length,
    hinweis:
      'Grundlage sind die Buchungen dieses Stapels (Personenkonten als Haupt- oder Gegenkonto), kein periodenübergreifender OPOS-Abgleich. Ob ein Posten wirklich noch offen (unbezahlt) ist, zeigt die Summen-/Saldenliste bzw. das OPOS aus der DATEV-Cloud.',
    items,
  };
};
