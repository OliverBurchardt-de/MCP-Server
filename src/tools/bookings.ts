import { z } from 'zod';
import type { BookingFilter } from '../parser/types.js';
import { datevStore } from '../store/memory.js';

export const listBookingsSchema = {
  account: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  minAmount: z.number().optional(),
  text: z.string().optional()
};

const matchesFilter = (filter: BookingFilter, booking: ReturnType<typeof datevStore.get>['bookings'][number]): boolean => {
  if (filter.account && booking.account !== filter.account && booking.contraAccount !== filter.account) {
    return false;
  }

  if (filter.from && booking.bookingDate < filter.from) {
    return false;
  }

  if (filter.to && booking.bookingDate > filter.to) {
    return false;
  }

  if (typeof filter.minAmount === 'number' && booking.amount < filter.minAmount) {
    return false;
  }

  if (filter.text) {
    const haystack = [booking.bookingText, booking.documentField1, booking.documentField2].join(' ').toLowerCase();
    if (!haystack.includes(filter.text.toLowerCase())) {
      return false;
    }
  }

  return true;
};

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
      documentField2: booking.documentField2
    }));

  return {
    count: items.length,
    items
  };
};
