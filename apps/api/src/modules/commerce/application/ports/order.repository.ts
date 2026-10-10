import type {
  OrderStatus,
  OrderTransitionCause,
  PaymentStatus,
  RefundStatus,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { IdempotentOrder } from '../../domain/checkout';

/* ----------------------------------------------------------------------------------------
 * Checkout (schema doc §8.2)
 * -------------------------------------------------------------------------------------- */

export interface NewOrderLine {
  readonly courseId: string;
  /** The course owner at sale time (snapshot). */
  readonly instructorId: string;
  /** The live title at sale time (snapshot, 1–60). */
  readonly courseTitle: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly couponId: string | null;
}

export interface NewOrder {
  readonly userId: string;
  readonly idempotencyKey: string;
  /** The quote fingerprint, lowercase hex of 32 bytes (`orders.request_fingerprint`). */
  readonly fingerprint: string;
  readonly currency: string;
  /** Σ line finals; "0.00" makes the order born PAID (D14). */
  readonly totalAmount: string;
  /** In cart order; `line_no` follows it. */
  readonly lines: readonly NewOrderLine[];
  readonly revenueShareBps: number;
  /** `payments.session_expires_at = date_trunc('second', now()) + ttl` (total > 0 only). */
  readonly sessionTtlMinutes: number;
}

export interface PlacedOrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly courseId: string;
}

export interface PlacedOrder {
  readonly orderId: string;
  readonly orderNumber: number;
  readonly status: 'PENDING_PAYMENT' | 'PAID';
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly lines: readonly PlacedOrderLine[];
}

/** What the provider call needs, read AFTER tx A committed (no transaction is held). */
export interface CheckoutSnapshot {
  readonly orderId: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly totalAmount: string;
  readonly paymentStatus: PaymentStatus | null;
  readonly sessionExpiresAt: Date | null;
  readonly checkoutSessionId: string | null;
  readonly checkoutUrl: string | null;
  /** In `line_no` order. */
  readonly lines: readonly { readonly courseTitle: string; readonly finalAmount: string }[];
}

/* ----------------------------------------------------------------------------------------
 * Transitions (schema doc §8.3, §8.5)
 * -------------------------------------------------------------------------------------- */

/** `lockOrder`: the order row FOR UPDATE (after the cart lock). */
export interface LockedOrderRecord {
  readonly orderId: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly totalAmount: string;
  readonly currency: string;
  readonly paymentStatus: PaymentStatus | null;
  readonly checkoutSessionId: string | null;
}

export interface MarkPaidInput {
  readonly orderId: string;
  readonly cause: 'PROVIDER_EVENT' | 'RECONCILER';
  readonly providerEventId: string;
  readonly checkoutSessionId: string;
  readonly paymentIntentId: string;
  readonly receivedAmount: string;
  /** Upper case. */
  readonly receivedCurrency: string;
}

export interface PaidLineRef {
  readonly id: string;
  readonly courseId: string;
  readonly finalAmount: string;
}

export type MarkPaidResult =
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'DUPLICATE_EFFECT'; readonly userId: string; readonly status: OrderStatus }
  | {
      readonly outcome: 'APPLIED';
      readonly userId: string;
      readonly previousStatus: OrderStatus;
      readonly paidAt: Date;
      /** Ascending course id (the grant order, schema doc R8). */
      readonly lines: readonly PaidLineRef[];
    }
  | { readonly outcome: 'MISMATCH'; readonly userId: string; readonly previousStatus: OrderStatus };

export interface CloseOrderInput {
  readonly orderId: string;
  /** EXPIRED (session expired) or CANCELED (buyer or reconciler). */
  readonly toStatus: 'EXPIRED' | 'CANCELED';
  readonly cause: Extract<OrderTransitionCause, 'PROVIDER_EVENT' | 'RECONCILER' | 'USER_CANCEL'>;
  /** The buyer for USER_CANCEL, else null. */
  readonly actorId: string | null;
  /** The claimed provider event (real or `reconcile:…`), if any. */
  readonly providerEventId: string | null;
  /** CANCELED with a CREATING payment: the session the provider made for it, if any. */
  readonly abandonedSessionId?: string | null;
}

/** Every field of an `OrderPaid` line (design §7), snapshotted on `order_lines`. */
export interface PaidOrderLineRecord {
  readonly orderLineId: string;
  readonly courseId: string;
  readonly instructorId: string;
  readonly courseTitle: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly finalAmount: string;
  readonly couponId: string | null;
  readonly couponCode: string | null;
  readonly revenueShareBps: number;
  readonly instructorShareAmount: string;
  readonly platformShareAmount: string;
}

export interface OrderHeaderRecord {
  readonly orderId: string;
  readonly orderNumber: number;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly totalAmount: string;
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly closedAt: Date | null;
}

/* ----------------------------------------------------------------------------------------
 * Reads (design §5 ListMyOrders / GetMyOrder / GetReceipt)
 * -------------------------------------------------------------------------------------- */

/** Keyset position: `placed_at` as exact SQL text (no µs loss, §14) + the id. */
export interface OrderKeyset {
  readonly placedAt: string;
  readonly id: string;
}

export interface OrderSummaryRecord {
  readonly id: string;
  readonly orderNumber: number;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly totalAmount: string;
  readonly lineCount: number;
  readonly courseTitles: readonly string[];
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly keyset: OrderKeyset;
}

export interface OrderLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly instructorId: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly finalAmount: string;
  readonly couponCode: string | null;
  readonly latestRefund: { readonly id: string; readonly status: RefundStatus } | null;
}

export interface OrderDetailRecord extends OrderHeaderRecord {
  /** null for a zero-total order. */
  readonly payment: {
    readonly status: PaymentStatus;
    readonly checkoutUrl: string | null;
  } | null;
  /** Σ SUCCEEDED refunds. */
  readonly refundedAmount: string;
  /** In `line_no` order. */
  readonly lines: readonly OrderLineRecord[];
}

/**
 * `commerce.orders` and its children (`order_lines`, `order_transitions`, `payments`,
 * `coupon_redemptions`): the checkout writes (schema doc §8.2), the PAID / EXPIRED / CANCELED
 * transitions (§8.3, §8.5) and the buyer's reads. Lock order (R8): the caller locks the cart
 * first; `lockOrder` is step 2; coupons and enrollments come later.
 */
export abstract class OrderRepository {
  /** By `(user_id, idempotency_key)` (resume, R7); null when the key is new for the user. */
  abstract findByIdempotencyKey(
    trx: Transaction<DB>,
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentOrder | null>;

  /** The user's one PENDING_PAYMENT order (D15), with the url while its session is OPEN. */
  abstract findPendingCheckout(
    userId: string,
    ex?: Executor,
  ): Promise<{ readonly orderId: string; readonly checkoutUrl: string | null } | null>;

  /**
   * Tx A body (schema doc §8.2): the order (PENDING_PAYMENT, or PAID when the total is 0),
   * one redemption per distinct coupon (RESERVED, or CONSUMED on a zero-total order), the
   * lines, the CREATING payment (total > 0) and the first transition (CHECKOUT / ZERO_TOTAL,
   * actor = buyer). Constraint violations propagate unmapped (the use case maps them).
   */
  abstract placeOrder(trx: Transaction<DB>, order: NewOrder): Promise<PlacedOrder>;

  abstract findCheckoutSnapshot(orderId: string, ex?: Executor): Promise<CheckoutSnapshot | null>;

  /** Tx B: CREATING -> OPEN with the session; false = the payment already left CREATING. */
  abstract openPayment(
    trx: Transaction<DB>,
    orderId: string,
    session: { readonly sessionId: string; readonly url: string },
  ): Promise<boolean>;

  /** Lock step 2 (after the cart). */
  abstract lockOrder(trx: Transaction<DB>, orderId: string): Promise<LockedOrderRecord | null>;

  /** `orders.user_id` without a lock (immutable). */
  abstract findOwner(orderId: string, ex?: Executor): Promise<string | null>;

  abstract findOrderIdBySession(sessionId: string, ex?: Executor): Promise<string | null>;

  abstract findOrderIdByPaymentIntent(
    paymentIntentId: string,
    ex?: Executor,
  ): Promise<string | null>;

  /**
   * §8.3 steps 1–5 (`markOrderPaid`): cart lock, order lock, payment SUCCEEDED, order PAID (or
   * PAYMENT_REVIEW on a received mismatch) + transition, redemptions CONSUMED.
   */
  abstract markPaid(trx: Transaction<DB>, input: MarkPaidInput): Promise<MarkPaidResult>;

  /**
   * PENDING_PAYMENT -> EXPIRED / CANCELED under the caller's cart + order locks: payment OPEN
   * -> EXPIRED or CREATING -> ABANDONED (url cleared), order closed + transition, RESERVED
   * redemptions RELEASED. Returns `closed_at`.
   *
   * @throws Error when the order is not PENDING_PAYMENT (the caller checks under the lock)
   */
  abstract closeOrder(trx: Transaction<DB>, input: CloseOrderInput): Promise<Date>;

  /**
   * ADMIN accept of a PAYMENT_REVIEW order (design §4): PAYMENT_REVIEW -> PAID with
   * `paid_at = now()` and the ADMIN transition (actor + reason >= 10), redemptions CONSUMED.
   * Under the caller's cart + order locks; grants and `OrderPaid` are `OrderLifecycle.settlePaid`.
   * Returns `paid_at`, or null when the order is not PAYMENT_REVIEW.
   */
  abstract acceptReviewedPayment(
    trx: Transaction<DB>,
    input: { readonly orderId: string; readonly actorId: string; readonly reason: string },
  ): Promise<Date | null>;

  /** The order's header (status, totals, times). */
  abstract findHeader(orderId: string, ex?: Executor): Promise<OrderHeaderRecord | null>;

  /** The `OrderPaid` lines (with coupon codes), in `line_no` order. */
  abstract findPaidLines(orderId: string, ex: Executor): Promise<PaidOrderLineRecord[]>;

  /**
   * D15: a SYSTEM `DUPLICATE_PURCHASE` refund, APPROVED at once (the P4-T16 dispatcher sends
   * it), plus its first transition. Inside the PAID transaction, after the order update.
   */
  abstract insertDuplicatePurchaseRefund(
    trx: Transaction<DB>,
    input: {
      readonly orderId: string;
      readonly orderLineId: string;
      readonly userId: string;
      readonly amount: string;
    },
  ): Promise<{ readonly refundId: string; readonly approvedAt: Date }>;

  /**
   * §8.3 step 7 under the cart lock: removes the bought courses from the cart and clears the
   * cart's code when it is the code of a coupon this order consumed.
   */
  abstract removePurchasedFromCart(
    trx: Transaction<DB>,
    input: {
      readonly userId: string;
      readonly orderId: string;
      readonly courseIds: readonly string[];
    },
  ): Promise<void>;

  /** The buyer's orders, newest first (`placed_at DESC, id DESC`). */
  abstract listForUser(
    userId: string,
    page: { readonly after?: OrderKeyset; readonly limit: number },
    ex?: Executor,
  ): Promise<OrderSummaryRecord[]>;

  abstract findDetail(orderId: string, ex?: Executor): Promise<OrderDetailRecord | null>;
}
