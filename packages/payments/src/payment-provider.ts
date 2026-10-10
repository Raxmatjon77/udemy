import type { ProviderEvent } from './webhook/provider-event';

/**
 * The payment provider port used by the api's commerce module (design §3, D9). Only the API process
 * holds the Stripe secret key; nothing here is called inside a database transaction.
 *
 * Money is always INTEGER MINOR UNITS (cents). Currencies are upper-case ISO 4217 (`USD`) on this
 * port; the Stripe adapter lower-cases them on the wire and upper-cases them on the way back.
 */
export interface PaymentProvider {
  /**
   * Creates a hosted Checkout Session for an order snapshot. Idempotent per key: replaying the same
   * key with the same input returns the same session (Stripe keeps keys for at least 24 h).
   * Use `checkoutSessionIdempotencyKey(orderId)`.
   */
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
    options: IdempotentRequestOptions,
  ): Promise<CheckoutSessionCreated>;

  retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession>;

  /**
   * Expires an open session. A session that is already expired or complete is reported, not
   * thrown: `ALREADY_COMPLETE` means "the payment went through, wait for the webhook".
   */
  expireCheckoutSession(sessionId: string): Promise<ExpireCheckoutSessionResult>;

  /** Use `refundIdempotencyKey(refundId, attempt)`. */
  createRefund(
    input: CreateRefundInput,
    options: IdempotentRequestOptions,
  ): Promise<ProviderRefund>;

  retrieveRefund(providerRefundId: string): Promise<ProviderRefund>;

  /**
   * Verifies the `Stripe-Signature` header over the RAW request bytes (never a re-serialized
   * object), then parses and normalizes the event. Throws `WebhookSignatureInvalidError`.
   *
   * @param toleranceSeconds maximum |now − t| in seconds; default 300. Must be > 0.
   * @param now the server clock; injectable for tests.
   */
  verifyWebhook(
    rawBody: Buffer,
    signatureHeader: string | readonly string[] | undefined,
    secret: string,
    toleranceSeconds?: number,
    now?: Date,
  ): ProviderEvent;
}

/** The DI token for `PaymentProvider` (an interface cannot be a Nest token). */
export const PAYMENT_PROVIDER = Symbol.for('@udemy/payments:PaymentProvider');

export interface IdempotentRequestOptions {
  /** 1–255 characters. Never reuse a key with different parameters. */
  readonly idempotencyKey: string;
}

export interface CheckoutLineItem {
  /** The course title snapshot; shown on the hosted page. 1–250 characters. */
  readonly name: string;
  /** The final (post-discount) line amount in minor units; an integer ≥ 0. */
  readonly unitAmountMinor: number;
  /** Default 1 (a course is bought once). */
  readonly quantity?: number;
}

export interface CreateCheckoutSessionInput {
  readonly orderId: string;
  /** Upper-case ISO 4217, e.g. `USD`. */
  readonly currency: string;
  /** 1–100 lines. */
  readonly lines: readonly CheckoutLineItem[];
  /** Prefills the hosted page; null lets the buyer type it. */
  readonly customerEmail: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Stripe accepts 30 min – 24 h from now. */
  readonly expiresAt: Date;
  /**
   * Extra metadata copied to the session AND the payment intent. `orderId` is always set by the
   * adapter and cannot be overridden.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CheckoutSessionCreated {
  readonly sessionId: string;
  /** The hosted page URL the browser is redirected to (redact it in logs). */
  readonly url: string;
  readonly expiresAt: Date;
}

export type CheckoutSessionStatus = 'open' | 'complete' | 'expired';
export type CheckoutPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required';

export interface ProviderCheckoutSession {
  readonly sessionId: string;
  readonly status: CheckoutSessionStatus;
  readonly paymentStatus: CheckoutPaymentStatus;
  /** `metadata.orderId`. */
  readonly orderId: string | null;
  readonly clientReferenceId: string | null;
  readonly paymentIntentId: string | null;
  readonly amountTotalMinor: number | null;
  /** Upper-case ISO 4217. */
  readonly currency: string | null;
  readonly url: string | null;
  readonly expiresAt: Date;
  readonly livemode: boolean;
}

export type ExpireCheckoutSessionResult = 'EXPIRED' | 'ALREADY_EXPIRED' | 'ALREADY_COMPLETE';

/** Stripe's refund reasons; `duplicate` for the D15 auto-refund. */
export type RefundReason = 'duplicate' | 'fraudulent' | 'requested_by_customer';

export interface CreateRefundInput {
  readonly paymentIntentId: string;
  /** The full order-line amount in minor units; an integer > 0. */
  readonly amountMinor: number;
  /** Our `commerce.refunds.id`; stored as `metadata.refundId` and echoed by refund webhooks. */
  readonly refundId: string;
  readonly reason?: RefundReason;
  /** Extra metadata (e.g. `orderId`); `refundId` cannot be overridden. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Our view of a provider refund status:
 * `pending` / `requires_action` → PENDING, `succeeded` → SUCCEEDED, `failed` / `canceled` → FAILED.
 */
export type ProviderRefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface ProviderRefund {
  readonly providerRefundId: string;
  readonly status: ProviderRefundStatus;
  /** Stripe's raw status, for logs and the admin UI. */
  readonly providerStatus: string;
  /** `metadata.refundId`. */
  readonly refundId: string | null;
  readonly paymentIntentId: string | null;
  readonly amountMinor: number;
  /** Upper-case ISO 4217. */
  readonly currency: string;
  /** Stripe's `failure_reason` when FAILED (`lost_or_stolen_card`, `expired_or_canceled_card`, ...). */
  readonly failureReason: string | null;
}

/** `checkout-session:{orderId}` (design §8 idempotency). */
export function checkoutSessionIdempotencyKey(orderId: string): string {
  return `checkout-session:${orderId}`;
}

/** `refund:{refundId}:{attempt}`; `attempt` starts at 1 and grows with each admin retry. */
export function refundIdempotencyKey(refundId: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`refund attempt must be a positive integer, got ${attempt}`);
  }
  return `refund:${refundId}:${attempt}`;
}

export function mapRefundStatus(providerStatus: string | null | undefined): ProviderRefundStatus {
  switch (providerStatus) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
    case 'canceled':
      return 'FAILED';
    default:
      // pending, requires_action, and any status Stripe adds later: not terminal for us.
      return 'PENDING';
  }
}
