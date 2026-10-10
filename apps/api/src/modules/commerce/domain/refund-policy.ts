import { REFUND_REVIEW_THRESHOLD, type RefundStatus } from '@udemy/contracts';

/*
 * Refund rules (design D11, §4 refund state machine, decision Q3). Pure functions; the use
 * cases evaluate them under the buyer's cart lock (the per-user mutex, schema doc R5) with the
 * DATABASE clock.
 */

/** Statuses that block another refund of the line (`refunds_order_line_id_live_uq`). */
export const LIVE_REFUND_STATUSES: readonly RefundStatus[] = [
  'REQUESTED',
  'APPROVED',
  'SUBMITTED',
  'SUCCEEDED',
];

export function isLiveRefund(status: RefundStatus): boolean {
  return LIVE_REFUND_STATUSES.includes(status);
}

/**
 * What a student request becomes (D11). The window, the 0.00 line and the order status are
 * checked first by `lineRefundState` (those are eligibility); this only decides who approves:
 *
 * - `AUTO_APPROVE`: fewer than `REFUND_REVIEW_THRESHOLD` (3) counted refunds in the lookback
 *   window and no objection from the consumption policy -> APPROVED at once;
 * - `NEEDS_REVIEW`: otherwise -> REQUESTED, an admin approves or rejects it.
 *
 * `recentRefundCount` is the buyer's STUDENT refunds that are not REJECTED, created in the
 * last 90 days, excluding this one (contracts `recentRefundCount`).
 */
export type StudentRefundDecision = 'AUTO_APPROVE' | 'NEEDS_REVIEW';

export function decideStudentRefund(input: {
  readonly recentRefundCount: number;
  /** A Phase 5 consumption objection (`RefundEligibilityPolicy`); null = none. */
  readonly consumptionObjection: string | null;
}): StudentRefundDecision {
  if (!Number.isSafeInteger(input.recentRefundCount) || input.recentRefundCount < 0) {
    throw new RangeError(`recentRefundCount must be a count, got ${input.recentRefundCount}`);
  }
  if (input.consumptionObjection !== null) return 'NEEDS_REVIEW';
  return input.recentRefundCount >= REFUND_REVIEW_THRESHOLD ? 'NEEDS_REVIEW' : 'AUTO_APPROVE';
}

const FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * A provider failure reason or error code as `refunds.failure_code` (`^[a-z0-9_]{1,64}$`):
 * lower-cased, other characters folded to `_`, truncated; `fallback` when nothing is left.
 */
export function refundFailureCode(raw: string | null | undefined, fallback: string): string {
  if (!FAILURE_CODE.test(fallback)) throw new RangeError(`Invalid fallback ${fallback}`);
  const folded = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return FAILURE_CODE.test(folded) ? folded : fallback;
}

/**
 * Whether a refund approval takes the course away (D11 "revoke at approval"): only when the
 * buyer's ACTIVE enrollment was granted by THIS order line. A duplicate-purchase line (D15),
 * a course re-bought or re-granted by an admin since, or a PAYMENT_REVIEW order (never
 * granted) keep the access the buyer holds through something else.
 */
export function approvalRevokesAccess(
  grant: { readonly source: string; readonly orderLineId: string | null } | null,
  orderLineId: string,
): boolean {
  return grant !== null && grant.source === 'ORDER' && grant.orderLineId === orderLineId;
}
