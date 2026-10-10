import type { ProviderEventOutcome } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type { ChargeRefundedData, ProviderEvent, RefundUpdatedData } from '@udemy/payments';

export interface RefundEventResult {
  readonly outcome: ProviderEventOutcome;
  /** The order the event belongs to, when known (recorded on `provider_events.order_id`). */
  readonly orderId: string | null;
}

/**
 * **P4-T16 seam.** Refund webhooks (`charge.refunded`, `refund.updated`, `refund.failed`):
 * `HandleProviderEvent` has already claimed the event in `trx` (dedupe) and records whatever
 * outcome this returns. P4-T15 binds `DeferredProviderRefundEvents` (records the event as
 * IGNORED); P4-T16 rebinds this token with the real handler (lock order, then refund;
 * SUBMITTED/APPROVED -> SUCCEEDED/FAILED, order status recompute, `RefundSucceeded` /
 * `RefundFailed`; match by `provider_refund_id`, then `metadata.refundId`; unknown -> ORPHAN).
 */
export abstract class ProviderRefundEvents {
  abstract apply(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeRefundedData | RefundUpdatedData,
  ): Promise<RefundEventResult>;
}

/**
 * **P4-T16 seam.** Called after a transaction that created APPROVED refunds commits (the
 * D15 duplicate-purchase refund of the PAID path), so the dispatcher sends them at once
 * instead of at its next poll. P4-T15 binds a no-op; P4-T16 binds `CommerceJobs` (kick).
 */
export abstract class RefundDispatchTrigger {
  abstract kick(): void;
}
