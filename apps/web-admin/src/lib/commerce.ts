import {
  formatMoney,
  type CouponState,
  type Currency,
  type EnrollmentRevokeReason,
  type EnrollmentSource,
  type EnrollmentStatus,
  type EnrollmentTransitionAction,
  type OrderStatus,
  type OrderTransitionCause,
  type PaymentStatus,
  type ProviderEventOutcome,
  type RefundInitiator,
  type RefundStatus,
} from '@udemy/contracts';

import type { BadgeVariant } from './labels';

/**
 * Commerce wording for the admin console (Phase 4 design §10). Money is always a decimal string
 * from the API and is only ever formatted with `formatMoney` (no floats, D3).
 */

/** `formatMoney` with this app's fixed locale, so server and client render the same text. */
export function money(amount: string, currency: Currency): string {
  return formatMoney(amount, currency, 'en-US');
}

/** `7000` → `70%`, `7050` → `70.5%`. */
export function formatBps(bps: number): string {
  return `${String(bps / 100)}%`;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'Pending payment',
  PAID: 'Paid',
  PAYMENT_REVIEW: 'Payment review',
  EXPIRED: 'Expired',
  CANCELED: 'Canceled',
  PARTIALLY_REFUNDED: 'Partially refunded',
  REFUNDED: 'Refunded',
};

export const ORDER_STATUS_BADGE: Record<OrderStatus, BadgeVariant> = {
  PENDING_PAYMENT: 'secondary',
  PAID: 'default',
  PAYMENT_REVIEW: 'destructive',
  EXPIRED: 'outline',
  CANCELED: 'outline',
  PARTIALLY_REFUNDED: 'secondary',
  REFUNDED: 'outline',
};

export const ORDER_TRANSITION_CAUSE_LABEL: Record<OrderTransitionCause, string> = {
  CHECKOUT: 'Checkout',
  ZERO_TOTAL: 'Zero-total order',
  PROVIDER_EVENT: 'Provider event',
  USER_CANCEL: 'Canceled by the buyer',
  RECONCILER: 'Reconciler',
  REFUND: 'Refund',
  ADMIN: 'Admin',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  CREATING: 'Creating',
  OPEN: 'Open',
  SUCCEEDED: 'Succeeded',
  EXPIRED: 'Expired',
  ABANDONED: 'Abandoned',
};

export const PROVIDER_EVENT_OUTCOME_LABEL: Record<ProviderEventOutcome, string> = {
  APPLIED: 'Applied',
  DUPLICATE_EFFECT: 'Duplicate effect',
  IGNORED: 'Ignored',
  ORPHAN: 'Orphan',
  MISMATCH: 'Amount mismatch',
};

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  REQUESTED: 'Needs review',
  APPROVED: 'Approved',
  SUBMITTED: 'Submitted',
  SUCCEEDED: 'Refunded',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};

export const REFUND_STATUS_BADGE: Record<RefundStatus, BadgeVariant> = {
  REQUESTED: 'secondary',
  APPROVED: 'secondary',
  SUBMITTED: 'secondary',
  SUCCEEDED: 'outline',
  FAILED: 'destructive',
  REJECTED: 'outline',
};

export const REFUND_INITIATOR_LABEL: Record<RefundInitiator, string> = {
  STUDENT: 'Student',
  ADMIN: 'Admin',
  SYSTEM: 'System',
};

/** A refund that blocks a new one on the same line (one live refund per line, §6). */
export function isLiveRefund(status: RefundStatus): boolean {
  return status !== 'REJECTED' && status !== 'FAILED';
}

export const COUPON_STATE_LABEL: Record<CouponState, string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  EXHAUSTED: 'Exhausted',
  EXPIRED: 'Expired',
  DEACTIVATED: 'Deactivated',
};

export const COUPON_STATE_BADGE: Record<CouponState, BadgeVariant> = {
  SCHEDULED: 'secondary',
  ACTIVE: 'default',
  EXHAUSTED: 'secondary',
  EXPIRED: 'outline',
  DEACTIVATED: 'outline',
};

export const ENROLLMENT_SOURCE_LABEL: Record<EnrollmentSource, string> = {
  ORDER: 'Purchase',
  FREE: 'Free enrollment',
  ADMIN: 'Granted by an admin',
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
};

export const ENROLLMENT_REVOKE_REASON_LABEL: Record<EnrollmentRevokeReason, string> = {
  REFUND: 'Refund',
  ADMIN: 'Admin',
  CHARGEBACK: 'Chargeback',
};

export const ENROLLMENT_ACTION_LABEL: Record<EnrollmentTransitionAction, string> = {
  GRANT: 'Granted',
  REVOKE: 'Revoked',
  REGRANT: 'Re-granted',
};

/** The refund count at which a student request goes to admin review (D11). */
export const REFUND_REVIEW_THRESHOLD = 3;

/** A Stripe test-dashboard link for a payment intent (design §10, provider STRIPE only). */
export function stripePaymentUrl(paymentIntentId: string, livemode: boolean): string {
  const mode = livemode ? '' : '/test';
  return `https://dashboard.stripe.com${mode}/payments/${encodeURIComponent(paymentIntentId)}`;
}

/**
 * `YYYY-MM-DD` (a date input, read as UTC) → the ISO instant that starts that day; with
 * `nextDay` the start of the following day (for an inclusive "to" date against `placedAt < to`).
 */
export function utcDayStart(date: string, nextDay = false): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + (nextDay ? 24 * 60 * 60 * 1000 : 0)).toISOString();
}

/** The inverse of `utcDayStart` for prefilling a date input. */
export function utcDayOf(iso: string, previousDay = false): string {
  const ms = Date.parse(iso) - (previousDay ? 24 * 60 * 60 * 1000 : 0);
  return new Date(ms).toISOString().slice(0, 10);
}
