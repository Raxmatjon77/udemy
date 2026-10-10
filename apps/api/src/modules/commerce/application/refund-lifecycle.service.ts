import { Injectable, Logger } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { approvalRevokesAccess } from '../domain/refund-policy';
import { CommerceEventPublisher } from './ports/commerce-event.publisher';
import { CommerceEnrollments } from './ports/context-gateways';
import { type RefundRecord, RefundRepository } from './ports/refund.repository';

/**
 * The side effects of the refund state machine (design §4, D11, §7) shared by the student
 * request, the admin actions, the dispatcher and the refund webhooks. Always on the CALLER's
 * transaction, after it took the cart (user) and order locks and changed the refund row.
 */
@Injectable()
export class RefundLifecycle {
  private readonly logger = new Logger(RefundLifecycle.name);

  constructor(
    private readonly refunds: RefundRepository,
    private readonly enrollments: CommerceEnrollments,
    private readonly events: CommerceEventPublisher,
  ) {}

  /**
   * The refund just became APPROVED (new, reviewed or retried): revoke the access this line
   * granted (D11 "revoke at approval", locked last, R8) and emit `RefundApproved`. Returns
   * whether the enrollment was revoked.
   */
  async approved(
    trx: Transaction<DB>,
    refund: RefundRecord,
    input: { readonly approvedBy: string | null; readonly approvedAt: Date },
  ): Promise<boolean> {
    const grant = await this.enrollments.findActiveGrant(refund.userId, refund.courseId, trx);
    let revoked = false;
    if (approvalRevokesAccess(grant, refund.orderLineId)) {
      const result = await this.enrollments.revoke(trx, {
        userId: refund.userId,
        courseId: refund.courseId,
        cause: 'REFUND',
        refundId: refund.id,
        actorId: input.approvedBy,
      });
      revoked = result.outcome === 'REVOKED';
    } else if (grant !== null) {
      this.logger.log(
        `refund ${refund.id}: the active enrollment was granted by ${grant.source}${grant.orderLineId === null ? '' : ` line ${grant.orderLineId}`}, not line ${refund.orderLineId}; access kept`,
      );
    }
    await this.events.refundApproved(trx, {
      refundId: refund.id,
      orderId: refund.orderId,
      orderLineId: refund.orderLineId,
      initiatedBy: refund.initiatedBy,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt.toISOString(),
    });
    return revoked;
  }

  /** A student request that needs review: `RefundRequested` (mail + admin alert). */
  async requested(trx: Transaction<DB>, refund: RefundRecord): Promise<void> {
    await this.events.refundRequested(trx, {
      refundId: refund.id,
      orderId: refund.orderId,
      orderLineId: refund.orderLineId,
      userId: refund.userId,
      courseId: refund.courseId,
      currency: refund.currency,
      amount: refund.amount,
      reasonCode: refund.reasonCode,
      requestedAt: refund.createdAt.toISOString(),
    });
  }

  async rejected(
    trx: Transaction<DB>,
    refund: RefundRecord,
    input: { readonly reason: string; readonly rejectedAt: Date },
  ): Promise<void> {
    await this.events.refundRejected(trx, {
      refundId: refund.id,
      orderId: refund.orderId,
      userId: refund.userId,
      reason: input.reason,
      rejectedAt: input.rejectedAt.toISOString(),
    });
  }

  /**
   * The refund is SUCCEEDED and the order status was recomputed in this transaction:
   * `RefundSucceeded` with the line's SQL-generated shares (the ledger mirror entry). The
   * enrollment was already revoked at approval.
   */
  async succeeded(trx: Transaction<DB>, refundId: string): Promise<void> {
    const facts = await this.refunds.findSucceededFacts(refundId, trx);
    if (facts === null) throw new Error(`refund ${refundId} is not SUCCEEDED in its transaction`);
    await this.events.refundSucceeded(trx, {
      refundId: facts.refundId,
      orderId: facts.orderId,
      orderLineId: facts.orderLineId,
      userId: facts.userId,
      courseId: facts.courseId,
      instructorId: facts.instructorId,
      currency: facts.currency,
      amount: facts.amount,
      instructorShareAmount: facts.instructorShareAmount,
      platformShareAmount: facts.platformShareAmount,
      succeededAt: facts.succeededAt.toISOString(),
    });
  }

  /** The refund is FAILED: `RefundFailed` (admin alert; the FAILED queue offers retry). */
  async failed(
    trx: Transaction<DB>,
    input: {
      readonly refundId: string;
      readonly orderId: string;
      readonly failureCode: string;
      readonly attempt: number;
      readonly failedAt: Date;
    },
  ): Promise<void> {
    this.logger.warn(
      `refund ${input.refundId} (attempt ${input.attempt}) FAILED: ${input.failureCode}`,
    );
    await this.events.refundFailed(trx, {
      refundId: input.refundId,
      orderId: input.orderId,
      failureCode: input.failureCode,
      attempt: input.attempt,
      failedAt: input.failedAt.toISOString(),
    });
  }
}
