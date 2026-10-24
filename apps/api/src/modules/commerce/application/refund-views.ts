import type {
  AdminBuyer,
  AdminRefund,
  AdminRefundQueueItem,
  CourseConsumption,
  PersonRef,
  Refund,
  RefundTransition,
} from '@udemy/contracts';
import { Money } from '../domain/money';
import type { CommerceAccount } from './ports/context-gateways';
import type { RefundRecord, RefundTransitionRecord } from './ports/refund.repository';

/** The buyer's view of a refund (`Refund`, design §8 `POST /me/orders/:orderId/refunds`). */
export function toRefundView(refund: RefundRecord): Refund {
  // Re-validated through Money: a malformed row is a 500, never output.
  const amount = Money.fromDecimal(refund.amount, refund.currency);
  return {
    id: refund.id,
    orderId: refund.orderId,
    orderLineId: refund.orderLineId,
    courseId: refund.courseId,
    courseTitle: refund.courseTitle,
    amount: amount.toDecimal(),
    currency: amount.currency,
    status: refund.status,
    initiatedBy: refund.initiatedBy,
    reasonCode: refund.reasonCode,
    comment: refund.comment,
    rejectionReason: refund.rejectionReason,
    attempt: refund.attempt,
    createdAt: refund.createdAt.toISOString(),
    approvedAt: refund.approvedAt?.toISOString() ?? null,
    succeededAt: refund.succeededAt?.toISOString() ?? null,
  };
}

/**
 * The admin view: plus the buyer id, who asked, the provider refund / failure, and the
 * consumption objection recorded at request time (Phase 5 D8).
 */
export function toAdminRefundView(refund: RefundRecord): AdminRefund {
  return {
    ...toRefundView(refund),
    userId: refund.userId,
    requestedBy: refund.requestedBy,
    providerRefundId: refund.providerRefundId,
    failureCode: refund.failureCode,
    reviewReason: refund.reviewReason,
  };
}

export function toAdminBuyer(account: CommerceAccount | undefined): AdminBuyer | null {
  return account === undefined
    ? null
    : {
        id: account.id,
        displayName: account.displayName,
        email: account.email,
        status: account.status,
      };
}

/** An admin-side actor reference (banned accounts are shown too; unknown = null). */
export function toActor(
  actorId: string | null,
  accounts: ReadonlyMap<string, CommerceAccount>,
): PersonRef | null {
  if (actorId === null) return null;
  const account = accounts.get(actorId);
  return account === undefined ? null : { id: account.id, displayName: account.displayName };
}

/**
 * A refund queue row: the D11 count as the rule saw it, and the buyer's CURRENT consumption of
 * the course (Phase 5 D8; read live by `CourseConsumptionViews`).
 */
export function toQueueItem(
  refund: RefundRecord,
  recentRefundCount: number,
  accounts: ReadonlyMap<string, CommerceAccount>,
  consumption: CourseConsumption,
): AdminRefundQueueItem {
  return {
    ...toAdminRefundView(refund),
    orderNumber: refund.orderNumber,
    buyer: toAdminBuyer(accounts.get(refund.userId)),
    recentRefundCount,
    consumption,
  };
}

export function toRefundTransitionView(
  row: RefundTransitionRecord,
  accounts: ReadonlyMap<string, CommerceAccount>,
): RefundTransition {
  return {
    seq: row.seq,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorId: row.actorId,
    actor: toActor(row.actorId, accounts),
    reason: row.reason,
    providerRefundId: row.providerRefundId,
    failureCode: row.failureCode,
    providerEventId: row.providerEventId,
    occurredAt: row.occurredAt.toISOString(),
  };
}
