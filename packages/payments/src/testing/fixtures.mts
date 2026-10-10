import { randomBytes } from 'node:crypto';
import { STRIPE_API_VERSION } from '../stripe/stripe-config.js';

/**
 * Builders for Stripe-shaped webhook event JSON (the subset of fields our normalizer reads, plus
 * the envelope). Currencies are LOWER-case here, as Stripe sends them. Every builder returns a
 * plain object: serialize it once (`signedWebhookRequest`) and send those bytes.
 */

export interface StripeEventJson {
  readonly id: string;
  readonly object: 'event';
  readonly api_version: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly pending_webhooks: number;
  readonly request: { readonly id: string | null; readonly idempotency_key: string | null };
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

export interface EventEnvelopeOptions {
  readonly id?: string;
  /** Unix seconds or a Date; default now. */
  readonly created?: number | Date;
  readonly livemode?: boolean;
  readonly apiVersion?: string;
}

/** `prefix_` + 24 random alphanumerics, e.g. `fakeStripeId('cs_test')`. */
export function fakeStripeId(prefix: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(24);
  let id = '';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return `${prefix}_${id}`;
}

function seconds(value: number | Date | undefined): number {
  if (value === undefined) return Math.floor(Date.now() / 1000);
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
}

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: EventEnvelopeOptions = {},
): StripeEventJson {
  return {
    id: options.id ?? fakeStripeId('evt'),
    object: 'event',
    api_version: options.apiVersion ?? STRIPE_API_VERSION,
    created: seconds(options.created),
    livemode: options.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

export interface CheckoutSessionFixture {
  readonly sessionId?: string;
  /** Written to `metadata.orderId` and `client_reference_id` unless overridden. */
  readonly orderId: string | null;
  readonly clientReferenceId?: string | null;
  readonly amountTotalMinor?: number;
  /** Upper or lower case; sent lower-case. Default `usd`. */
  readonly currency?: string;
  readonly paymentIntentId?: string | null;
  readonly paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  readonly expiresAt?: number | Date;
}

function checkoutSessionObject(
  fixture: CheckoutSessionFixture,
  status: 'complete' | 'expired',
): Record<string, unknown> {
  const paymentStatus = fixture.paymentStatus ?? (status === 'complete' ? 'paid' : 'unpaid');
  return {
    id: fixture.sessionId ?? fakeStripeId('cs_test'),
    object: 'checkout.session',
    mode: 'payment',
    status,
    payment_status: paymentStatus,
    amount_total: fixture.amountTotalMinor ?? 1999,
    currency: (fixture.currency ?? 'usd').toLowerCase(),
    client_reference_id:
      fixture.clientReferenceId === undefined ? fixture.orderId : fixture.clientReferenceId,
    metadata: fixture.orderId === null ? {} : { orderId: fixture.orderId },
    payment_intent:
      fixture.paymentIntentId === undefined
        ? status === 'complete'
          ? fakeStripeId('pi')
          : null
        : fixture.paymentIntentId,
    expires_at: seconds(fixture.expiresAt ?? new Date(Date.now() + 30 * 60_000)),
    livemode: false,
    url: null,
  };
}

export function checkoutSessionCompletedEvent(
  fixture: CheckoutSessionFixture,
  options?: EventEnvelopeOptions,
): StripeEventJson {
  return stripeEvent(
    'checkout.session.completed',
    checkoutSessionObject(fixture, 'complete'),
    options,
  );
}

export function checkoutSessionExpiredEvent(
  fixture: CheckoutSessionFixture,
  options?: EventEnvelopeOptions,
): StripeEventJson {
  return stripeEvent(
    'checkout.session.expired',
    checkoutSessionObject(fixture, 'expired'),
    options,
  );
}

export interface ChargeRefundedFixture {
  readonly chargeId?: string;
  readonly paymentIntentId?: string | null;
  readonly amountMinor?: number;
  readonly amountRefundedMinor: number;
  readonly currency?: string;
}

export function chargeRefundedEvent(
  fixture: ChargeRefundedFixture,
  options?: EventEnvelopeOptions,
): StripeEventJson {
  const amount = fixture.amountMinor ?? fixture.amountRefundedMinor;
  return stripeEvent(
    'charge.refunded',
    {
      id: fixture.chargeId ?? fakeStripeId('ch'),
      object: 'charge',
      amount,
      amount_refunded: fixture.amountRefundedMinor,
      refunded: fixture.amountRefundedMinor >= amount,
      currency: (fixture.currency ?? 'usd').toLowerCase(),
      payment_intent:
        fixture.paymentIntentId === undefined ? fakeStripeId('pi') : fixture.paymentIntentId,
      livemode: false,
    },
    options,
  );
}

export interface RefundFixture {
  readonly providerRefundId?: string;
  /** Our refund id, in `metadata.refundId`; null for a dashboard refund. */
  readonly refundId: string | null;
  readonly paymentIntentId?: string | null;
  readonly amountMinor?: number;
  readonly currency?: string;
  /** Stripe's raw status. Default `succeeded` (updated) / `failed` (failed). */
  readonly status?: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
  readonly failureReason?: string | null;
}

function refundObject(fixture: RefundFixture, defaultStatus: string): Record<string, unknown> {
  const status = fixture.status ?? defaultStatus;
  return {
    id: fixture.providerRefundId ?? fakeStripeId('re'),
    object: 'refund',
    amount: fixture.amountMinor ?? 1999,
    currency: (fixture.currency ?? 'usd').toLowerCase(),
    status,
    metadata: fixture.refundId === null ? {} : { refundId: fixture.refundId },
    payment_intent:
      fixture.paymentIntentId === undefined ? fakeStripeId('pi') : fixture.paymentIntentId,
    failure_reason:
      fixture.failureReason === undefined
        ? status === 'failed'
          ? 'expired_or_canceled_card'
          : null
        : fixture.failureReason,
  };
}

export function refundUpdatedEvent(
  fixture: RefundFixture,
  options?: EventEnvelopeOptions,
): StripeEventJson {
  return stripeEvent('refund.updated', refundObject(fixture, 'succeeded'), options);
}

export function refundFailedEvent(
  fixture: RefundFixture,
  options?: EventEnvelopeOptions,
): StripeEventJson {
  return stripeEvent('refund.failed', refundObject(fixture, 'failed'), options);
}

export interface DisputeFixture {
  readonly disputeId?: string;
  readonly chargeId?: string;
  readonly paymentIntentId?: string | null;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly reason?: string;
}

export function chargeDisputeCreatedEvent(
  fixture: DisputeFixture = {},
  options?: EventEnvelopeOptions,
): StripeEventJson {
  return stripeEvent(
    'charge.dispute.created',
    {
      id: fixture.disputeId ?? fakeStripeId('dp'),
      object: 'dispute',
      amount: fixture.amountMinor ?? 1999,
      currency: (fixture.currency ?? 'usd').toLowerCase(),
      charge: fixture.chargeId ?? fakeStripeId('ch'),
      payment_intent:
        fixture.paymentIntentId === undefined ? fakeStripeId('pi') : fixture.paymentIntentId,
      reason: fixture.reason ?? 'fraudulent',
      status: 'needs_response',
    },
    options,
  );
}
