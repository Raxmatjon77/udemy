import { ErrorCode, type OrderStatus, type PaymentStatus } from '@udemy/contracts';
import { Money } from './money';
import type { Quote } from './quote';

/** Stripe's minimum charge (D3): a total in (0, 0.50) is `amount_below_minimum`. */
export const MIN_CHARGE_MINOR = 50;

export type CheckoutBlockCode =
  | typeof ErrorCode.CartEmpty
  | typeof ErrorCode.CartChanged
  | typeof ErrorCode.PriceChanged
  | typeof ErrorCode.AmountBelowMinimum;

/**
 * Why the re-quoted cart cannot be ordered as the buyer saw it (design §5 Checkout step 2.4),
 * checked in this order; null = place the order:
 *
 * 1. no line at all: `cart_empty`;
 * 2. any unavailable line: `cart_changed` (the quote explains each);
 * 3. total ≠ `expectedTotal`: `price_changed` (a price, a coupon or its limit changed);
 * 4. a total in (0, 0.50): `amount_below_minimum`. Zero is fine (D14: zero-total order).
 */
export function checkoutBlock(quote: Quote, expectedTotal: Money): CheckoutBlockCode | null {
  if (quote.lines.length === 0 && quote.unavailable.length === 0) return ErrorCode.CartEmpty;
  if (quote.unavailable.length > 0) return ErrorCode.CartChanged;
  if (!quote.totals.total.equals(expectedTotal)) return ErrorCode.PriceChanged;
  const total = quote.totals.total.minor;
  if (total > 0 && total < MIN_CHARGE_MINOR) return ErrorCode.AmountBelowMinimum;
  return null;
}

/** An order found by `(user_id, idempotency_key)`. */
export interface IdempotentOrder {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: Money;
  /** null for a zero-total order (no payment row). */
  readonly paymentStatus: PaymentStatus | null;
  readonly checkoutUrl: string | null;
  readonly sessionExpiresAt: Date | null;
}

export type ResumeDecision =
  /** A different request under the same key: 422 `idempotency_key_reused`. */
  | { readonly kind: 'reused' }
  /** Answer the order's current state (OPEN session url, PAID, closed, ...). */
  | {
      readonly kind: 'answer';
      readonly status: OrderStatus;
      readonly checkoutUrl: string | null;
    }
  /** Payment still CREATING and the stored `expires_at` is still acceptable: (re)create. */
  | { readonly kind: 'create' }
  /** Payment still CREATING but too late to create the session: abandon the order now. */
  | { readonly kind: 'abandon' };

/**
 * Resume by Idempotency-Key (design §5 step 2.2, R7). The SAME request is the same
 * `expectedTotal`: the order was created only when the quote total equalled it, so a request
 * with another total under this key is `idempotency_key_reused`. (The stored
 * `request_fingerprint` is the quote's, kept for audit; it cannot be re-derived after PAID,
 * because the paid items have left the cart.)
 *
 * A CREATING payment is resumed (same idempotency key, same stored `expires_at`) only while the
 * provider still accepts that `expires_at` for a fresh create, i.e. until `expires_at − 30
 * min` (schema doc §6 item 6); after that the order is abandoned.
 */
export function resumeDecision(
  order: IdempotentOrder,
  expectedTotal: Money,
  now: Date,
  minSessionLifetimeMinutes: number,
): ResumeDecision {
  if (!order.total.equals(expectedTotal)) return { kind: 'reused' };
  if (order.status === 'PENDING_PAYMENT' && order.paymentStatus === 'CREATING') {
    const lastCreate =
      order.sessionExpiresAt === null
        ? Number.NEGATIVE_INFINITY
        : order.sessionExpiresAt.getTime() - minSessionLifetimeMinutes * 60_000;
    return now.getTime() < lastCreate ? { kind: 'create' } : { kind: 'abandon' };
  }
  const open = order.status === 'PENDING_PAYMENT' && order.paymentStatus === 'OPEN';
  return { kind: 'answer', status: order.status, checkoutUrl: open ? order.checkoutUrl : null };
}

export type CancelDecision = 'cancel' | 'already_closed' | 'not_cancelable';

/**
 * `CancelPendingOrder` (design §5): only a PENDING_PAYMENT order is canceled; an EXPIRED or
 * CANCELED one answers its current state (a repeat is a 200); anything paid or under review is
 * 409 `order_not_cancelable`.
 */
export function cancelDecision(status: OrderStatus): CancelDecision {
  if (status === 'PENDING_PAYMENT') return 'cancel';
  if (status === 'EXPIRED' || status === 'CANCELED') return 'already_closed';
  return 'not_cancelable';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The order ids a Checkout Session event may refer to, in the design's order (§5
 * HandleProviderEvent): `metadata.orderId`, then `client_reference_id`. Non-UUIDs are dropped
 * (never sent to SQL); the session id fallback is the caller's.
 */
export function orderIdCandidates(
  metadataOrderId: string | null,
  clientReferenceId: string | null,
): string[] {
  const ids = [metadataOrderId, clientReferenceId].filter(
    (id): id is string => id !== null && UUID.test(id),
  );
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/**
 * A provider amount in minor units as the decimal string of `payments.received_amount`.
 * Currency-agnostic on purpose (a mismatching currency must still be recorded): 2 decimals.
 * null when it cannot be stored (negative, not an integer, or beyond numeric(12,2)).
 */
export function receivedDecimal(minor: number): string | null {
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > 99_999_999_999) return null;
  const units = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, '0');
  return `${units}.${cents}`;
}

/** Minor units of a decimal money string in the platform currency (line amounts for Stripe). */
export function minorOf(amount: string, currency: string): number {
  return Money.fromDecimal(amount, currency).minor;
}
