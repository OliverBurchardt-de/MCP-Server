/**
 * Tool `get_account_balance`: berechnet den Saldo eines Kontos.
 *
 * @remarks
 * Der Saldo ergibt sich aus der Summe der Soll- minus der Haben-Bewegungen des
 * Kontos. Eine Buchung kann das Konto entweder direkt (`account`) oder als
 * Gegenkonto (`contraAccount`) betreffen — die Vorzeichenlogik in
 * {@link signedAmount} berücksichtigt beides spiegelbildlich.
 */
import { z } from 'zod';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: die Kontonummer als Zeichenkette. */
export const getAccountBalanceSchema = {
  account: z.string().min(1),
};

/**
 * Bestimmt den vorzeichenbehafteten Beitrag einer Buchung zum Saldo des Kontos.
 *
 * @remarks
 * Aus Sicht des gefragten Kontos: Steht es im `account`-Feld, wirkt Soll positiv
 * und Haben negativ. Steht es im Gegenkonto, kehrt sich die Wirkung um (die
 * Buchung betrifft das Konto dann spiegelbildlich). Betrifft die Buchung das
 * Konto gar nicht, ist der Beitrag 0.
 */
const signedAmount = (
  account: string,
  bookingAccount: string,
  contraAccount: string,
  amount: number,
  direction: 'S' | 'H'
): number => {
  if (account === bookingAccount) {
    return direction === 'S' ? amount : -amount;
  }

  if (account === contraAccount) {
    return direction === 'S' ? -amount : amount;
  }

  return 0;
};

/**
 * Berechnet Saldo, Buchungsanzahl und letztes Buchungsdatum eines Kontos.
 *
 * @param account - Kontonummer.
 * @returns Objekt mit `balance`, `bookingCount` und `lastBookingDate`.
 */
export const getAccountBalance = ({ account }: { account: string }) => {
  const dataset = datevStore.get();
  const matches = dataset.bookings.filter(
    (booking) =>
      booking.account === account || booking.contraAccount === account
  );
  const balance = matches.reduce(
    (sum, booking) =>
      sum +
      signedAmount(
        account,
        booking.account,
        booking.contraAccount,
        booking.amount,
        booking.direction
      ),
    0
  );
  const lastBookingDate =
    matches
      .map((booking) => booking.bookingDate)
      .sort()
      .at(-1) ?? null;

  return {
    account,
    accountName: null,
    bookingCount: matches.length,
    balance,
    lastBookingDate,
  };
};
