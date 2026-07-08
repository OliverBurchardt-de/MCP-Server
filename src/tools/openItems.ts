import { z } from 'zod';
import { getPersonAccountType } from '../parser/extf.js';
import type { OpenItem } from '../parser/types.js';
import { datevStore } from '../store/memory.js';

export const getOpenItemsSchema = {
  overdueOnly: z.boolean().optional(),
  type: z.enum(['debtor', 'creditor']).optional(),
  referenceDate: z.string().optional()
};

export const getOpenItems = ({
  overdueOnly,
  type,
  referenceDate
}: {
  overdueOnly?: boolean;
  type?: 'debtor' | 'creditor';
  referenceDate?: string;
}) => {
  const dataset = datevStore.get();
  const today = referenceDate ?? new Date().toISOString().slice(0, 10);

  const items = dataset.bookings
    .map<OpenItem | null>((booking) => {
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
        overdue
      };
    })
    .filter((item): item is OpenItem => item !== null)
    .filter((item) => (type ? item.accountType === type : true))
    .filter((item) => (overdueOnly ? item.overdue : true))
    .sort((left, right) => left.bookingDate.localeCompare(right.bookingDate));

  return {
    count: items.length,
    items
  };
};
