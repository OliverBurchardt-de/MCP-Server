/**
 * Tool `get_account_balance`: berechnet den Saldo eines Kontos.
 *
 * @remarks
 * Der Saldo ergibt sich aus der Summe der Soll- minus der Haben-Bewegungen des
 * Kontos. Eine Buchung kann das Konto entweder direkt (`account`) oder als
 * Gegenkonto (`contraAccount`) betreffen — die Vorzeichenlogik berücksichtigt
 * beides spiegelbildlich.
 *
 * Wichtig: Diese Datei rechnet den Saldo **deterministisch im Code** (nie durch
 * freies Aufsummieren im Sprachmodell). Für **Cloud-Daten** ist der hier
 * gerechnete Wert nur eine Kontrollrechnung — verbindlich ist die autoritative
 * Zahl aus DATEVs Summen-/Saldenliste (siehe {@link file://./cloud.ts},
 * Methode `accountBalance`).
 */
import { z } from 'zod';
import type { RequestContext } from '../context/context.js';
import { datasetWarning, datevStore } from '../store/memory.js';
import type { DatevBooking } from '../parser/types.js';

/** Eingabeschema: die Kontonummer als Ziffernfolge (optional gezielter Datensatz). */
export const getAccountBalanceSchema = {
  account: z
    .string()
    .regex(/^\d+$/, 'Kontonummer besteht nur aus Ziffern (z. B. 1200)'),
  dataset: z
    .string()
    .optional()
    .describe(
      'Optionaler Datensatz-Schlüssel (clientId:fiscalYearId), um gezielt einen bestimmten geladenen Mandanten/Wirtschaftsjahr abzufragen'
    ),
};

/**
 * Prüft, ob eine Buchungs-Kontonummer die gesuchte Kontonummer meint —
 * tolerant gegenüber dem technischen DATEV-Format.
 *
 * @remarks
 * DATEV führt Konten in zwei Schreibweisen: die Anzeige-/Kurznummer (z. B.
 * „1200", wie in der Summen-/Saldenliste) und ein **technisches Format**, bei
 * dem rechts mit Nullen aufgefüllt wird (z. B. „12000000", wie in den
 * Buchungssätzen). Ein Treffer gilt, wenn die Nummern exakt gleich sind ODER die
 * kürzere — rechts mit Nullen auf die Länge der längeren aufgefüllt — die
 * längere ergibt. Innerhalb eines Datensatzes haben die gespeicherten Konten
 * eine einheitliche Breite, daher ist das eindeutig.
 *
 * @param query - Vom Nutzer/Modell gefragte Kontonummer (z. B. „1200").
 * @param stored - Im Datensatz gespeicherte Kontonummer (z. B. „12000000").
 * @returns `true`, wenn beide dasselbe Konto meinen.
 */
export const accountMatches = (query: string, stored: string): boolean => {
  const q = query.trim();
  const s = stored.trim();
  if (q === s) {
    return true;
  }
  if (!/^\d+$/.test(q) || !/^\d+$/.test(s)) {
    return false;
  }
  const [short, long] = q.length <= s.length ? [q, s] : [s, q];
  return short.padEnd(long.length, '0') === long;
};

/** Ergebnis einer Saldo-Berechnung aus Buchungen. */
export interface AccountBalanceResult {
  account: string;
  accountName: string | null;
  bookingCount: number;
  /** Soll minus Haben (positiv = Sollsaldo, negativ = Habensaldo). */
  balance: number;
  lastBookingDate: string | null;
}

/**
 * Berechnet Saldo, Buchungsanzahl und letztes Buchungsdatum eines Kontos aus
 * einer Buchungsliste — die zentrale, deterministische Rechenlogik.
 *
 * @param bookings - Die zu berücksichtigenden Buchungen.
 * @param account - Gesuchte Kontonummer (Kurz- oder technische Form).
 * @param options.excludeOpeningBalance - Wenn `true`, werden
 *   Eröffnungsbilanz-/Saldenvortrags-Buchungen (`raw.isOpeningBalancePosting`)
 *   ausgeklammert. Nützlich, um DATEVs Jahresverkehrs-Saldo nachzurechnen.
 * @param options.tolerantAccountMatch - Wenn `true`, wird die technische
 *   Kontoschreibweise überbrückt ({@link accountMatches}). Standard ist
 *   **exakter** Vergleich — nur so lassen sich benachbarte Konten (z. B.
 *   Sachkonto `1200` vs. Debitor `12000`) sicher auseinanderhalten. Der tolerante
 *   Modus ist der Cloud-Kontrollrechnung vorbehalten, wo die verbindliche Zahl
 *   ohnehin aus DATEVs Summen-/Saldenliste stammt.
 * @returns Saldo, Anzahl der betroffenen Buchungen und letztes Buchungsdatum.
 */
export const computeAccountBalance = (
  bookings: DatevBooking[],
  account: string,
  options: {
    excludeOpeningBalance?: boolean;
    tolerantAccountMatch?: boolean;
  } = {}
): AccountBalanceResult => {
  const matches = options.tolerantAccountMatch
    ? accountMatches
    : (query: string, stored: string): boolean =>
        query.trim() === stored.trim();

  let balance = 0;
  let bookingCount = 0;
  let lastBookingDate: string | null = null;

  for (const booking of bookings) {
    if (
      options.excludeOpeningBalance &&
      booking.raw?.isOpeningBalancePosting === 'true'
    ) {
      continue;
    }

    const onAccount = matches(account, booking.account);
    const onContra = !onAccount && matches(account, booking.contraAccount);
    if (!onAccount && !onContra) {
      continue;
    }

    bookingCount += 1;
    // Aus Sicht des Kontos: als Hauptkonto wirkt Soll positiv/Haben negativ,
    // als Gegenkonto genau spiegelbildlich.
    if (onAccount) {
      balance += booking.direction === 'S' ? booking.amount : -booking.amount;
    } else {
      balance += booking.direction === 'S' ? -booking.amount : booking.amount;
    }

    if (
      booking.bookingDate &&
      (lastBookingDate === null || booking.bookingDate > lastBookingDate)
    ) {
      lastBookingDate = booking.bookingDate;
    }
  }

  return {
    account,
    accountName: null,
    bookingCount,
    balance,
    lastBookingDate,
  };
};

/**
 * Berechnet den Saldo eines Kontos aus dem aktiven Datensatz (Datei-Modus).
 *
 * @param ctx - Anfrage-Kontext (Kanzlei/Nutzer-Bindung des Store-Zugriffs).
 * @param account - Kontonummer.
 * @returns Objekt mit `balance`, `bookingCount` und `lastBookingDate`; bei
 *   unvollständigem Datensatz zusätzlich `datenstandWarnung` — ein Saldo aus
 *   einem Teilbestand darf nie unkommentiert erscheinen.
 * @remarks Für Cloud-Daten sollte stattdessen der autoritative Weg über
 *   `CloudTools.accountBalance` genutzt werden (DATEV-Summen-/Saldenliste).
 */
export const getAccountBalance = (
  ctx: RequestContext,
  {
    account,
    dataset: datasetKey,
  }: {
    account: string;
    dataset?: string;
  }
): AccountBalanceResult & { datenstandWarnung?: string } => {
  const dataset = datevStore.get(ctx, datasetKey);
  const result = computeAccountBalance(dataset.bookings, account);
  const warnung = datasetWarning(dataset);
  return warnung ? { ...result, datenstandWarnung: warnung } : result;
};
