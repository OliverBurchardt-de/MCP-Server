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
import { datasetWarning, datevStore } from '../store/memory.js';

/** Obergrenze der zurückgegebenen Posten (Kontext-Schutz). */
const MAX_ITEMS = 200;

/** Eingabeschema: optionale Filter nach Typ, Überfälligkeit, Stichtag und Anzahl. */
export const getOpenItemsSchema = {
  dataset: z
    .string()
    .optional()
    .describe(
      'Optionaler Datensatz-Schlüssel (clientId:fiscalYearId), um gezielt einen bestimmten geladenen Datensatz abzufragen'
    ),
  overdueOnly: z.boolean().optional(),
  type: z.enum(['debtor', 'creditor']).optional(),
  referenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Stichtag als ISO-Datum JJJJ-MM-TT')
    .optional(),
  maxResults: z.number().int().min(1).max(MAX_ITEMS).optional(),
};

/**
 * Bestimmt die Personenkonto-Posten einer Buchung (aus Sicht jedes betroffenen
 * Personenkontos).
 *
 * @remarks
 * Eine Buchung kann **beide** Seiten auf Personenkonten haben (z. B. eine
 * Debitoren-/Kreditoren-Umbuchung). Dann entstehen **zwei** Posten. Steht das
 * Personenkonto im Gegenkonto, dreht sich die Soll/Haben-Richtung (die Buchung
 * betrifft das Konto spiegelbildlich). Vorzeichenkonvention: Debitor-Forderung
 * positiv, Kreditor-Verbindlichkeit negativ.
 */
const toPersonPostings = (
  booking: DatevBooking,
  today: string,
  accountLength: number
): OpenItem[] => {
  const build = (
    account: string,
    accountType: 'debtor' | 'creditor',
    direction: 'S' | 'H'
  ): OpenItem => ({
    account,
    accountType,
    amount: direction === 'S' ? booking.amount : -booking.amount,
    dueDate: booking.dueDate,
    bookingDate: booking.bookingDate,
    bookingText: booking.bookingText,
    documentField1: booking.documentField1,
    documentField2: booking.documentField2,
    overdue: Boolean(booking.dueDate && booking.dueDate < today),
  });

  const postings: OpenItem[] = [];
  const primaryType = getPersonAccountType(booking.account, accountLength);
  if (primaryType) {
    postings.push(build(booking.account, primaryType, booking.direction));
  }
  const contraType = getPersonAccountType(booking.contraAccount, accountLength);
  if (contraType) {
    // Gegenkonto: Richtung spiegelbildlich zur Hauptbuchung.
    postings.push(
      build(
        booking.contraAccount,
        contraType,
        booking.direction === 'S' ? 'H' : 'S'
      )
    );
  }
  return postings;
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
  dataset: datasetKey,
}: {
  overdueOnly?: boolean;
  type?: 'debtor' | 'creditor';
  referenceDate?: string;
  maxResults?: number;
  dataset?: string;
}) => {
  const dataset = datevStore.get(datasetKey);
  const today = referenceDate ?? new Date().toISOString().slice(0, 10);
  const accountLength = dataset.header.accountLength || 4;

  const all = dataset.bookings
    .flatMap((booking) => toPersonPostings(booking, today, accountLength))
    .filter((item) => (type ? item.accountType === type : true))
    .filter((item) => (overdueOnly ? item.overdue : true))
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate));

  const items = all.slice(0, maxResults ?? MAX_ITEMS);

  const warnung = datasetWarning(dataset);
  return {
    count: all.length,
    angezeigt: items.length,
    ...(warnung ? { datenstandWarnung: warnung } : {}),
    hinweis:
      'Grundlage sind die Buchungen dieses Stapels (Personenkonten als Haupt- oder Gegenkonto), kein periodenübergreifender OPOS-Abgleich. Ob ein Posten wirklich noch offen (unbezahlt) ist, zeigt die Summen-/Saldenliste bzw. das OPOS aus der DATEV-Cloud.',
    items,
  };
};
