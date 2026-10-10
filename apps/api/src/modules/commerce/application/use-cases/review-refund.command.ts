import { Injectable } from '@nestjs/common';
import type { AdminRefundQueueItem, RefundStatus } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { CommerceInvalidTransition, RefundNotFound } from '../../domain/commerce.errors';
import { CartRepository } from '../ports/cart.repository';
import { CommerceAdminDirectory } from '../ports/context-gateways';
import { OrderRepository } from '../ports/order.repository';
import { RefundDispatchTrigger } from '../ports/provider-refund-events';
import { type RefundRecord, RefundRepository } from '../ports/refund.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { RefundLifecycle } from '../refund-lifecycle.service';
import { toQueueItem } from '../refund-views';

export type RefundDecision = 'approve' | 'reject' | 'retry';

export interface ReviewRefundInput {
  readonly adminId: string;
  readonly refundId: string;
  readonly decision: RefundDecision;
  /** Required for reject (10–2000, mailed to the student); an optional note otherwise. */
  readonly reason?: string;
}

const EXPECTED: Readonly<Record<RefundDecision, RefundStatus>> = {
  approve: 'REQUESTED',
  reject: 'REQUESTED',
  retry: 'FAILED',
};

/**
 * The admin refund decisions (design §5 `ReviewRefund`, `RetryRefund`), each conditional on
 * the current status and written with the log row and the outbox event in one transaction:
 *
 * - approve: REQUESTED -> APPROVED, the access the line granted is revoked (D11),
 *   `RefundApproved`, then the dispatcher kick;
 * - reject: REQUESTED -> REJECTED with the reason, `RefundRejected` (mailed); access kept;
 * - retry: FAILED -> APPROVED with attempt + 1 (a NEW idempotency key `refund:{id}:{n}`), the
 *   revoke rule again (an admin may have re-granted meanwhile: that access is kept),
 *   `RefundApproved`, then the kick.
 *
 * Lock order (R8): the buyer's cart, the order, the refund, then the enrollment.
 */
@Injectable()
export class ReviewRefundCommand {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly carts: CartRepository,
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly lifecycle: RefundLifecycle,
    private readonly directory: CommerceAdminDirectory,
    private readonly dispatch: RefundDispatchTrigger,
  ) {}

  /**
   * @throws RefundNotFound (404)
   * @throws CommerceInvalidTransition (409 `invalid_state_transition`) when the refund is not
   *   REQUESTED (approve / reject) or FAILED (retry)
   * @throws ConflictError (409 `refund_already_requested`) when a retry finds another live
   *   refund of the line
   */
  async execute(input: ReviewRefundInput): Promise<AdminRefundQueueItem> {
    const refund = await this.tx.run(async (trx) => {
      const found = await this.refunds.findById(input.refundId, trx);
      if (found === null) throw new RefundNotFound();
      await this.carts.lockCart(trx, found.userId);
      await this.orders.lockOrder(trx, found.orderId);
      const locked = await this.refunds.lock(trx, found.id);
      if (locked === null) throw new RefundNotFound();
      if (locked.status !== EXPECTED[input.decision]) {
        throw new CommerceInvalidTransition(
          `The refund is ${locked.status}; ${input.decision} needs ${EXPECTED[input.decision]}.`,
        );
      }
      return input.decision === 'reject'
        ? this.reject(trx, locked, input)
        : this.approve(trx, locked, input);
    });
    if (refund.status === 'APPROVED') this.dispatch.kick([refund.id]);
    const accounts = await this.directory.findAccounts([refund.userId]);
    return toQueueItem(refund, await this.refunds.recentRefundCountOf(refund.id), accounts);
  }

  private async approve(
    trx: Transaction<DB>,
    refund: RefundRecord,
    input: ReviewRefundInput,
  ): Promise<RefundRecord> {
    const done = await this.refunds.transition(trx, {
      refundId: refund.id,
      from: [refund.status],
      to: 'APPROVED',
      actorId: input.adminId,
      reason: input.reason ?? null,
    });
    if (!done.applied || done.at === null) throw new CommerceInvalidTransition();
    const approved = await this.reload(trx, refund.id);
    await this.lifecycle.approved(trx, approved, {
      approvedBy: input.adminId,
      approvedAt: done.at,
    });
    return approved;
  }

  private async reject(
    trx: Transaction<DB>,
    refund: RefundRecord,
    input: ReviewRefundInput,
  ): Promise<RefundRecord> {
    const reason = input.reason;
    if (reason === undefined) throw new RangeError('reject needs a reason');
    const done = await this.refunds.transition(trx, {
      refundId: refund.id,
      from: ['REQUESTED'],
      to: 'REJECTED',
      actorId: input.adminId,
      reason,
    });
    if (!done.applied || done.at === null) throw new CommerceInvalidTransition();
    const rejected = await this.reload(trx, refund.id);
    await this.lifecycle.rejected(trx, rejected, { reason, rejectedAt: done.at });
    return rejected;
  }

  private async reload(trx: Transaction<DB>, refundId: string): Promise<RefundRecord> {
    const refund = await this.refunds.findById(refundId, trx);
    if (refund === null) throw new Error(`refund ${refundId} vanished inside its transaction`);
    return refund;
  }
}
