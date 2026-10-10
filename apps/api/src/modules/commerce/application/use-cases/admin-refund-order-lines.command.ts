import { Injectable } from '@nestjs/common';
import type { AdminRefund } from '@udemy/contracts';
import {
  OrderNotFound,
  RefundAlreadyRequested,
  RefundNotApplicable,
} from '../../domain/commerce.errors';
import { Money } from '../../domain/money';
import { isLiveRefund } from '../../domain/refund-policy';
import { CartRepository } from '../ports/cart.repository';
import { OrderRepository } from '../ports/order.repository';
import { RefundDispatchTrigger } from '../ports/provider-refund-events';
import { type RefundRecord, RefundRepository } from '../ports/refund.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { RefundLifecycle } from '../refund-lifecycle.service';
import { toAdminRefundView } from '../refund-views';

export interface AdminRefundOrderLinesInput {
  readonly adminId: string;
  readonly orderId: string;
  readonly orderLineIds: readonly string[];
  /** 10–2000 characters (every admin money action has a reason, §9). */
  readonly reason: string;
}

/**
 * `AdminRefund` (design §5): APPROVED full-line refunds issued by an admin, ignoring the
 * refund window and the abuse rule, in ONE transaction (all lines or none).
 *
 * - PAID / PARTIALLY_REFUNDED orders: reason code ADMIN_DISCRETION; each refund revokes the
 *   access its line granted (D11) and emits `RefundApproved`.
 * - PAYMENT_REVIEW orders (amount mismatch, never enrolled): the order is refunded as a WHOLE
 *   (every non-zero line must be listed), reason code PAYMENT_REVIEW; when the provider
 *   settles them the order goes PAYMENT_REVIEW -> REFUNDED (schema doc §8.4b).
 *
 * Lock order (R8): the buyer's cart, the order, then enrollments in ascending course id.
 */
@Injectable()
export class AdminRefundOrderLinesCommand {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly carts: CartRepository,
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly lifecycle: RefundLifecycle,
    private readonly dispatch: RefundDispatchTrigger,
  ) {}

  /**
   * @throws OrderNotFound (404) for an unknown order or a line not in it
   * @throws RefundAlreadyRequested (409) when a line has a live refund
   * @throws RefundNotApplicable (422) for an unpaid order, a 0.00 line, or a partial refund of
   *   a PAYMENT_REVIEW order
   */
  async execute(input: AdminRefundOrderLinesInput): Promise<AdminRefund[]> {
    const created = await this.tx.run(async (trx) => {
      const buyer = await this.orders.findOwner(input.orderId, trx);
      if (buyer === null) throw new OrderNotFound();
      await this.carts.lockCart(trx, buyer);
      const locked = await this.orders.lockOrder(trx, input.orderId);
      const order = await this.orders.findDetail(input.orderId, trx);
      if (locked === null || order === null) throw new OrderNotFound();
      const review = order.status === 'PAYMENT_REVIEW';
      if (!review && order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') {
        throw new RefundNotApplicable('Only a paid order can be refunded.');
      }
      const isZero = (amount: string): boolean =>
        Money.fromDecimal(amount, order.currency).isZero();
      const lines = input.orderLineIds.map((id) => {
        const line = order.lines.find((l) => l.id === id);
        if (line === undefined) throw new OrderNotFound();
        if (isZero(line.finalAmount)) {
          throw new RefundNotApplicable('A free (0.00) line has nothing to refund.');
        }
        if (line.latestRefund !== null && isLiveRefund(line.latestRefund.status)) {
          throw new RefundAlreadyRequested();
        }
        return line;
      });
      if (
        review &&
        order.lines.some((l) => !isZero(l.finalAmount) && !input.orderLineIds.includes(l.id))
      ) {
        throw new RefundNotApplicable('A payment under review is refunded as a whole.');
      }
      const results: RefundRecord[] = [];
      // Ascending course id: the revokes lock enrollments in that order (R8).
      for (const line of [...lines].sort((a, b) => (a.courseId < b.courseId ? -1 : 1))) {
        const refund = await this.refunds.insert(trx, {
          orderId: order.orderId,
          orderLineId: line.id,
          userId: buyer,
          amount: line.finalAmount,
          status: 'APPROVED',
          initiatedBy: 'ADMIN',
          reasonCode: review ? 'PAYMENT_REVIEW' : 'ADMIN_DISCRETION',
          comment: null,
          actorId: input.adminId,
          reason: input.reason,
        });
        await this.lifecycle.approved(trx, refund, {
          approvedBy: input.adminId,
          approvedAt: refund.approvedAt ?? refund.createdAt,
        });
        results.push(refund);
      }
      return results;
    });
    this.dispatch.kick(created.map((r) => r.id));
    const order = new Map(input.orderLineIds.map((id, index) => [id, index]));
    return created
      .sort((a, b) => (order.get(a.orderLineId) ?? 0) - (order.get(b.orderLineId) ?? 0))
      .map(toAdminRefundView);
  }
}
