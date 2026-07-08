export interface DatevHeader {
  advisorNumber: string;
  clientNumber: string;
  fiscalYearStart: string;
  accountLength: number;
  accountFramework: string;
  dateFrom: string;
  dateTo: string;
  consultantName?: string;
  clientName?: string;
  rawLine1: string[];
  rawLine2: string[];
}

export interface DatevBooking {
  bookingDate: string;
  dueDate?: string;
  account: string;
  contraAccount: string;
  amount: number;
  direction: 'S' | 'H';
  bookingText: string;
  documentField1: string;
  documentField2: string;
  currency: string;
  invoiceReference?: string;
  isOpenItem: boolean;
  rowNumber: number;
  raw: Record<string, string>;
}

export interface DatevDataset {
  filePath: string;
  header: DatevHeader;
  columns: string[];
  bookings: DatevBooking[];
  loadedAt: string;
}

export interface OpenItem {
  account: string;
  accountType: 'debtor' | 'creditor';
  amount: number;
  dueDate?: string;
  bookingDate: string;
  bookingText: string;
  documentField1: string;
  documentField2: string;
  overdue: boolean;
}

export interface BookingFilter {
  account?: string;
  from?: string;
  to?: string;
  minAmount?: number;
  text?: string;
}
