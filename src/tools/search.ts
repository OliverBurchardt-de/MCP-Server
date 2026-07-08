import { z } from 'zod';
import { datevStore } from '../store/memory.js';

export const searchDocumentsSchema = {
  query: z.string().min(1)
};

export const searchDocuments = ({ query }: { query: string }) => {
  const dataset = datevStore.get();
  const needle = query.toLowerCase();
  const items = dataset.bookings
    .filter((booking) => [booking.bookingText, booking.documentField1, booking.documentField2].join(' ').toLowerCase().includes(needle))
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate))
    .map((booking) => ({
      bookingDate: booking.bookingDate,
      account: booking.account,
      contraAccount: booking.contraAccount,
      amount: booking.amount,
      direction: booking.direction,
      bookingText: booking.bookingText,
      documentField1: booking.documentField1,
      documentField2: booking.documentField2
    }));

  return {
    count: items.length,
    items
  };
};
