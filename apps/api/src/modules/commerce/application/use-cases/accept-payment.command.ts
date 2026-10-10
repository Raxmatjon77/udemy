import { Injectable } from '@nestjs/common';
import type { AdminOrderDetail } from '@udemy/contracts';
import { CommerceInvalidTransition, OrderNotFound } from '../../domain/commerce.errors';
import { AdminOrderViews } from '../admin-order-views.service';
import { OrderLifecycle } from '../order-lifecycle.service';
import { CartRepository } from '../ports/cart.repository';
import { OrderRepository } from '../ports/order.repository';
import { RefundDispatchTrigger } from '../ports/provider-refund-events';
import { RefundRepository } from '../ports/refund.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface AcceptPaymentInput {
  readonly adminId: string;
  readonly orderId: string;
  /** 10–2000 characters, on the ADMIN transition. */
  readonly reason: string;
}

/**
 * `POST /admin/orders/:orderId/accept-payment` (design §4 `PAYMENT_REVIEW -> PAID: ADMIN
 * accept`): an admin accepts a payment whose amount or currency did not match the order. One
 * transaction, under the buyer's cart and the order locks: PAID with `paid_at = now()` (the
 * refund window starts here) and the ADMIN transition, coupon redemptions CONSUMED, then the
 * same settlement as a webhook payment (`OrderLifecycle.settlePaid`: grants, D15 duplicate
 * refunds, cart cleanup, `OrderPaid`). Duplicate refunds are kicked after COMMIT.
 *
 * The alternative, refunding the payment, is `POST /admin/orders/:orderId/refunds` with every
 * line; an order with a live or succeeded refund can no longer be accepted.
 */
@Injectable()
export class AcceptPaymentCommand {
  constructor(
    private readonly tx: TransactionRunner,
    private readonly carts: CartRepository,
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly lifecycle: OrderLifecycle,
    private readonly views: AdminOrderViews,
    private readonly dispatch: RefundDispatchTrigger,
  ) {}

  /**
   * @throws OrderNotFound (404)
   * @throws CommerceInvalidTransition (409) when the order is not PAYMENT_REVIEW, or has a
   *   refund that is not REJECTED / FAILED
   */
  async execute(input: AcceptPaymentInput): Promise<AdminOrderDetail> {
    const { duplicates, detail } = await this.tx.run(async (trx) => {
      const buyer = await this.orders.findOwner(input.orderId, trx);
      if (buyer === null) throw new OrderNotFound();
      await this.carts.lockCart(trx, buyer);
      const order = await this.orders.lockOrder(trx, input.orderId);
      if (order === null) throw new OrderNotFound();
      if (order.status !== 'PAYMENT_REVIEW') {
        throw new CommerceInvalidTransition(`The order is ${order.status}, not PAYMENT_REVIEW.`);
      }
      const refunds = await this.refunds.listForOrder(input.orderId, trx);
      if (refunds.some((r) => r.status !== 'REJECTED' && r.status !== 'FAILED')) {
        throw new CommerceInvalidTransition('The order is being refunded; it cannot be accepted.');
      }
      const paidAt = await this.orders.acceptReviewedPayment(trx, {
        orderId: input.orderId,
        actorId: input.adminId,
        reason: input.reason,
      });
      if (paidAt === null) throw new CommerceInvalidTransition();
      const lines = await this.orders.findPaidLines(input.orderId, trx);
      const settled = await this.lifecycle.settlePaid(trx, {
        orderId: input.orderId,
        userId: buyer,
        provider: 'STRIPE',
        paidAt,
        lines: lines.map((l) => ({
          id: l.orderLineId,
          courseId: l.courseId,
          finalAmount: l.finalAmount,
        })),
      });
      return {
        duplicates: settled.duplicateRefundIds,
        detail: await this.views.detailIn(input.orderId, trx),
      };
    });
    this.dispatch.kick(duplicates);
    return detail;
  }
}
