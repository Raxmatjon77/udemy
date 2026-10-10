import type { CheckoutPaymentStatus, ProviderRefundStatus } from '../payment-provider';

/**
 * A verified, NORMALIZED provider event. The envelope carries what dedupe and the livemode guard
 * need (`id`, `createdAt`, `livemode`); `data` is a discriminated union on `data.type` of the
 * Stripe event types commerce handles. Everything else is `{ type: 'unhandled' }` (answer 200 and
 * record it; never fail an unknown event, Stripe would retry it for 3 days).
 */
export interface ProviderEvent {
  /** Stripe's event id (`evt_…`); the `commerce.provider_events` PK together with the provider. */
  readonly id: string;
  /** The raw Stripe event type, e.g. `checkout.session.completed` (also for unhandled events). */
  readonly providerType: string;
  readonly createdAt: Date;
  /** Must be false in Phase 4; the use case ignores (and logs) a mismatch. */
  readonly livemode: boolean;
  /** The API version the event was rendered with, when present. */
  readonly apiVersion: string | null;
  readonly data: ProviderEventData;
}

export type ProviderEventData =
  | CheckoutSessionCompletedData
  | CheckoutSessionExpiredData
  | ChargeRefundedData
  | RefundUpdatedData
  | ChargeDisputeCreatedData
  | UnhandledEventData;

export type HandledProviderEventType = Exclude<ProviderEventData['type'], 'unhandled'>;

export interface CheckoutSessionCompletedData {
  readonly type: 'checkout.session.completed';
  readonly sessionId: string;
  /** `metadata.orderId`; the use case falls back to `clientReferenceId`, then `sessionId`. */
  readonly orderId: string | null;
  readonly clientReferenceId: string | null;
  /** Only `paid` may move an order to PAID. */
  readonly paymentStatus: CheckoutPaymentStatus;
  readonly paymentIntentId: string | null;
  readonly amountTotalMinor: number | null;
  /** Upper-case ISO 4217. */
  readonly currency: string | null;
}

export interface CheckoutSessionExpiredData {
  readonly type: 'checkout.session.expired';
  readonly sessionId: string;
  readonly orderId: string | null;
  readonly clientReferenceId: string | null;
}

/**
 * `charge.refunded`. Since API 2022-11-15 a charge no longer embeds its refunds, so this carries
 * only charge-level totals; per-refund state comes from `refund.updated` / `refund.failed`.
 */
export interface ChargeRefundedData {
  readonly type: 'charge.refunded';
  readonly chargeId: string;
  readonly paymentIntentId: string | null;
  readonly amountMinor: number;
  readonly amountRefundedMinor: number;
  /** True when the charge is fully refunded. */
  readonly fullyRefunded: boolean;
  readonly currency: string;
}

/** `refund.updated` and `refund.failed` (the latter always has status FAILED). */
export interface RefundUpdatedData {
  readonly type: 'refund.updated' | 'refund.failed';
  readonly providerRefundId: string;
  /** `metadata.refundId`; null for refunds created outside our dispatcher (dashboard). */
  readonly refundId: string | null;
  readonly paymentIntentId: string | null;
  readonly status: ProviderRefundStatus;
  readonly providerStatus: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly failureReason: string | null;
}

export interface ChargeDisputeCreatedData {
  readonly type: 'charge.dispute.created';
  readonly disputeId: string;
  readonly chargeId: string | null;
  readonly paymentIntentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly status: string | null;
}

export interface UnhandledEventData {
  readonly type: 'unhandled';
}

export const HANDLED_PROVIDER_EVENT_TYPES: readonly HandledProviderEventType[] = [
  'checkout.session.completed',
  'checkout.session.expired',
  'charge.refunded',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
];
