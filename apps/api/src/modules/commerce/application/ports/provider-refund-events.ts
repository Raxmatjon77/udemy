import type { ProviderEventOutcome } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type { ChargeRefundedData, ProviderEvent, RefundUpdatedData } from '@udemy/payments';

export interface RefundEventResult {
  readonly outcome: ProviderEventOutcome;
  /** The order the event belongs to, when known (recorded on `provider_events.order_id`). */
  readonly orderId: string | null;
}

/**
 * Refund webhooks (`charge.refunded`, `refund.updated`, `refund.failed`): `HandleProviderEvent`
 * has already claimed the event in `trx` (dedupe) and records whatever outcome this returns.
 * Bound to `ProviderRefundEventsHandler` (P4-T16): order lock, then refund; APPROVED/SUBMITTED
 * -> SUCCEEDED/FAILED, order status recompute, `RefundSucceeded` / `RefundFailed`; matched by
 * `provider_refund_id`, then `metadata.refundId`; unknown -> ORPHAN.
 */
export abstract class ProviderRefundEvents {
  abstract apply(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeRefundedData | RefundUpdatedData,
  ): Promise<RefundEventResult>;
}

/**
 * Called after a transaction that APPROVED refunds commits (auto-approval, admin approve /
 * refund / retry, the D15 duplicate-purchase refund of the PAID path), so the dispatcher sends
 * exactly those at once instead of at its next poll. Fire and forget: never throws. Bound to
 * `RefundDispatchKick` (P4-T16).
 */
export abstract class RefundDispatchTrigger {
  abstract kick(refundIds: readonly string[]): void;
}
