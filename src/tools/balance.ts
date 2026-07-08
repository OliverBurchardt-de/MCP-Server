import { z } from 'zod';
import { datevStore } from '../store/memory.js';

export const getAccountBalanceSchema = {
  account: z.string().min(1)
};

const signedAmount = (account: string, bookingAccount: string, contraAccount: string, amount: number, direction: 'S' | 'H'): number => {
  if (account === bookingAccount) {
    return direction === 'S' ? amount : -amount;
  }

  if (account === contraAccount) {
    return direction === 'S' ? -amount : amount;
  }

  return 0;
};

export const getAccountBalance = ({ account }: { account: string }) => {
  const dataset = datevStore.get();
  const matches = dataset.bookings.filter((booking) => booking.account === account || booking.contraAccount === account);
  const balance = matches.reduce(
    (sum, booking) => sum + signedAmount(account, booking.account, booking.contraAccount, booking.amount, booking.direction),
    0
  );
  const lastBookingDate = matches.map((booking) => booking.bookingDate).sort().at(-1) ?? null;

  return {
    account,
    accountName: null,
    bookingCount: matches.length,
    balance,
    lastBookingDate
  };
};
