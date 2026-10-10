import {
  formatMoney,
  isFreeAmount,
  type Currency,
  type OrderStatus,
  type RefundStatus,
} from '@udemy/contracts';

/**
 * Display helpers for money and commerce states. Amounts are the contracts' decimal strings;
 * they go to `formatMoney` (Intl with the string itself), never through a float.
 */

/** The app's display locale (the rest of the UI is English too, see lib/format.ts). */
export const MONEY_LOCALE = 'en-US';

/** `$19.99`. */
export function money(amount: string, currency: Currency): string {
  return formatMoney(amount, currency, MONEY_LOCALE);
}

/** `-$5.00` for a discount line (0.00 stays `$0.00`). */
export function discount(amount: string, currency: Currency): string {
  return isFreeAmount(amount) ? money(amount, currency) : `-${money(amount, currency)}`;
}

/** A course price: "Free" for 0.00 (D14), otherwise the formatted amount. */
export function priceLabel(amount: string, currency: Currency): string {
  return isFreeAmount(amount) ? 'Free' : money(amount, currency);
}

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PAYMENT_REVIEW: 'Payment under review',
  EXPIRED: 'Expired',
  CANCELED: 'Canceled',
  PARTIALLY_REFUNDED: 'Partially refunded',
  REFUNDED: 'Refunded',
};

export const REFUND_STATUS_LABELS: Readonly<Record<RefundStatus, string>> = {
  REQUESTED: 'Refund under review',
  APPROVED: 'Refund approved, processing',
  SUBMITTED: 'Refund processing',
  SUCCEEDED: 'Refunded',
  FAILED: 'Refund delayed, our team is on it',
  REJECTED: 'Refund declined',
};
