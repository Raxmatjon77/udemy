import {
  ErrorCode,
  type OrderStatus,
  type RefundBlockReason,
  type RefundStatus,
} from '@udemy/contracts';

const DAY_MS = 86_400_000;

/** Refund statuses that block a new request for the line (one live refund per line, §6). */
const LIVE_REFUND_STATUSES: readonly RefundStatus[] = [
  'REQUESTED',
  'APPROVED',
  'SUBMITTED',
  'SUCCEEDED',
];

export interface LineRefundInput {
  readonly orderStatus: OrderStatus;
  /** null until the order was paid (PAYMENT_REVIEW has no `paid_at`, schema doc §6 item 11). */
  readonly paidAt: Date | null;
  readonly finalMinor: number;
  /** The line's newest refund, if any. */
  readonly latestRefund: { readonly id: string; readonly status: RefundStatus } | null;
  /** The database clock. */
  readonly now: Date;
  readonly refundWindowDays: number;
}

export interface LineRefundState {
  readonly refundId: string | null;
  readonly status: RefundStatus | null;
  readonly refundableUntil: Date | null;
  readonly eligible: boolean;
  readonly reason: RefundBlockReason | null;
}

/**
 * The "Request refund" state of one order line (design §5 `GetMyOrder`, D11), the same rules
 * as `RequestRefund` checks (P4-T16 owns the request itself; its abuse rule only decides
 * auto-approve vs review, never eligibility):
 *
 * 1. a live refund exists: `refund_already_requested`;
 * 2. not paid, a 0.00 line, or the order is not PAID / PARTIALLY_REFUNDED: `refund_not_applicable`;
 * 3. past `paid_at + COMMERCE_REFUND_WINDOW_DAYS`: `refund_window_closed`.
 */
export function lineRefundState(input: LineRefundInput): LineRefundState {
  const refundable = input.paidAt !== null && input.finalMinor > 0;
  const refundableUntil =
    refundable && input.paidAt !== null
      ? new Date(input.paidAt.getTime() + input.refundWindowDays * DAY_MS)
      : null;
  const base = {
    refundId: input.latestRefund?.id ?? null,
    status: input.latestRefund?.status ?? null,
    refundableUntil,
  };
  const reason = blockReason(input, refundableUntil);
  return { ...base, eligible: reason === null, reason };
}

function blockReason(input: LineRefundInput, until: Date | null): RefundBlockReason | null {
  if (input.latestRefund !== null && LIVE_REFUND_STATUSES.includes(input.latestRefund.status)) {
    return ErrorCode.RefundAlreadyRequested;
  }
  if (
    until === null ||
    (input.orderStatus !== 'PAID' && input.orderStatus !== 'PARTIALLY_REFUNDED')
  ) {
    return ErrorCode.RefundNotApplicable;
  }
  if (input.now.getTime() > until.getTime()) return ErrorCode.RefundWindowClosed;
  return null;
}
