import { Injectable } from '@nestjs/common';
import {
  REFUND_REVIEW_LOOKBACK_DAYS,
  type Refund,
  type StudentRefundReasonCode,
} from '@udemy/contracts';
import { OrderNotFound, refundBlockedError } from '../../domain/commerce.errors';
import { Money } from '../../domain/money';
import { lineRefundState } from '../../domain/order-line-refund-state';
import { decideStudentRefund } from '../../domain/refund-policy';
import { CommerceSettings } from '../commerce-settings';
import { CartRepository } from '../ports/cart.repository';
import { CommerceClock } from '../ports/commerce-clock';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { OrderRepository } from '../ports/order.repository';
import { RefundDispatchTrigger } from '../ports/provider-refund-events';
import { RefundEligibilityPolicy } from '../ports/refund-eligibility.policy';
import { RefundRepository } from '../ports/refund.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { RefundLifecycle } from '../refund-lifecycle.service';
import { toRefundView } from '../refund-views';

export interface RequestRefundInput {
  readonly userId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly reasonCode: StudentRefundReasonCode;
  readonly comment?: string;
}

/**
 * `RequestRefund` (design §5, D11): a full-line refund of the buyer's own order.
 *
 * 1. Rate limit (5 / 24 h per user; every attempt counts).
 * 2. One transaction: the buyer's cart row (the per-user mutex, so two concurrent requests
 *    cannot both count 2 and auto-approve, R5) -> the order row -> the line resolved WITHIN
 *    the order -> eligibility (`lineRefundState` at the DATABASE clock: no live refund, a paid
 *    PAID / PARTIALLY_REFUNDED order, a non-zero line, inside `COMMERCE_REFUND_WINDOW_DAYS`).
 * 3. The review rules: fewer than 3 counted refunds in 90 days AND no consumption objection
 *    (`RefundEligibilityPolicy`, Phase 5 `LearningConsumptionPolicy`: an ACTIVE certificate, or
 *    more than 30% of the live video watched or of the live lectures completed) -> APPROVED at
 *    once (the access THIS line granted is revoked in the same transaction, `RefundApproved`);
 *    otherwise REQUESTED for an admin (`RefundRequested`: student acknowledgement + admin
 *    alert). The objection, if any, is recorded as the reason of the first refund transition
 *    (the audit trail of why it needs review; contracts `AdminRefund.reviewReason`).
 * 4. After COMMIT, an approved refund is kicked to the dispatcher.
 */
@Injectable()
export class RequestRefundCommand {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly carts: CartRepository,
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly lifecycle: RefundLifecycle,
    private readonly policy: RefundEligibilityPolicy,
    private readonly limiter: CommerceRateLimiter,
    private readonly clock: CommerceClock,
    private readonly settings: CommerceSettings,
    private readonly dispatch: RefundDispatchTrigger,
  ) {}

  /**
   * @throws OrderNotFound (404) for an unknown or foreign order, or a line not in it
   * @throws RefundAlreadyRequested (409) when the line has a live refund
   * @throws RefundWindowClosed / RefundNotApplicable (422)
   * @throws RateLimitedError (429)
   */
  async execute(input: RequestRefundInput): Promise<Refund> {
    await this.limiter.hitRefundRequest(input.userId);
    const refund = await this.tx.run(async (trx) => {
      if ((await this.orders.findOwner(input.orderId, trx)) !== input.userId) {
        throw new OrderNotFound();
      }
      await this.carts.lockCart(trx, input.userId);
      if ((await this.orders.lockOrder(trx, input.orderId)) === null) throw new OrderNotFound();
      const order = await this.orders.findDetail(input.orderId, trx);
      const line = order?.lines.find((l) => l.id === input.orderLineId);
      if (order === null || line === undefined) throw new OrderNotFound();

      const state = lineRefundState({
        orderStatus: order.status,
        paidAt: order.paidAt,
        finalMinor: Money.fromDecimal(line.finalAmount, order.currency).minor,
        latestRefund: line.latestRefund,
        now: await this.clock.now(trx),
        refundWindowDays: this.settings.refundWindowDays,
      });
      if (state.reason !== null) throw refundBlockedError(state.reason);

      const recentRefundCount = await this.refunds.countRecentStudentRefunds(
        trx,
        input.userId,
        REFUND_REVIEW_LOOKBACK_DAYS,
      );
      // Learning reads only (no locks), after the cart and order locks (R8).
      const objection = await this.policy.objection(
        { userId: input.userId, courseId: line.courseId, orderLineId: line.id },
        trx,
      );
      const decision = decideStudentRefund({ recentRefundCount, consumptionObjection: objection });
      const created = await this.refunds.insert(trx, {
        orderId: order.orderId,
        orderLineId: line.id,
        userId: input.userId,
        amount: line.finalAmount,
        status: decision === 'AUTO_APPROVE' ? 'APPROVED' : 'REQUESTED',
        initiatedBy: 'STUDENT',
        reasonCode: input.reasonCode,
        comment: input.comment ?? null,
        actorId: input.userId,
        // NEEDS_REVIEW because of consumption: why, on the first transition (audit).
        reason: objection,
      });
      if (created.status === 'APPROVED') {
        await this.lifecycle.approved(trx, created, {
          approvedBy: null,
          approvedAt: created.approvedAt ?? created.createdAt,
        });
      } else {
        await this.lifecycle.requested(trx, created);
      }
      return created;
    });
    if (refund.status === 'APPROVED') this.dispatch.kick([refund.id]);
    return toRefundView(refund);
  }
}
