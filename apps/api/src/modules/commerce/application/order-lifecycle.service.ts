import { Injectable, Logger } from '@nestjs/common';
import type { OrderSettlementProvider } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { Money } from '../domain/money';
import { CommerceEventPublisher } from './ports/commerce-event.publisher';
import { CommerceEnrollments } from './ports/context-gateways';
import { type CloseOrderInput, OrderRepository, type PaidLineRef } from './ports/order.repository';

export interface SettlePaidOrderInput {
  readonly orderId: string;
  readonly userId: string;
  /** NONE: a zero-total order (D14). */
  readonly provider: OrderSettlementProvider;
  readonly paidAt: Date;
  /** Every line of the order. */
  readonly lines: readonly PaidLineRef[];
}

export interface SettlementResult {
  /** D15 duplicate-purchase refunds created (APPROVED): kick the dispatcher after COMMIT. */
  readonly duplicateRefundIds: readonly string[];
}

/**
 * The parts of the order state machine (design §4) shared by checkout, the webhook, cancel
 * and the reconciler. Always on the CALLER's transaction, under its cart + order locks.
 */
@Injectable()
export class OrderLifecycle {
  private readonly logger = new Logger(OrderLifecycle.name);

  constructor(
    private readonly orders: OrderRepository,
    private readonly enrollments: CommerceEnrollments,
    private readonly events: CommerceEventPublisher,
  ) {}

  /**
   * The order just became PAID (schema doc §8.3 steps 6–8, D8): grant every line (ascending
   * course id, enrollments are locked last), turn an ALREADY_ACTIVE line into a SYSTEM
   * `DUPLICATE_PURCHASE` refund (D15, a 0.00 line has nothing to refund), remove the bought
   * courses (and a consumed code) from the cart, and emit `OrderPaid`. `EnrollmentGranted` is
   * written by the enrollment facade.
   */
  async settlePaid(trx: Transaction<DB>, input: SettlePaidOrderInput): Promise<SettlementResult> {
    const header = await this.orders.findHeader(input.orderId, trx);
    if (header === null) throw new Error(`order ${input.orderId} vanished inside its transaction`);
    const duplicateRefundIds: string[] = [];
    const lines = [...input.lines].sort((a, b) =>
      a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0,
    );
    for (const line of lines) {
      const grant = await this.enrollments.grant(trx, {
        userId: input.userId,
        courseId: line.courseId,
        source: 'ORDER',
        orderLineId: line.id,
      });
      if (grant.newlyGranted) continue;
      if (Money.fromDecimal(line.finalAmount, header.currency).isZero()) {
        this.logger.warn(
          `order ${input.orderId}: line ${line.id} is a 0.00 duplicate of an active enrollment; nothing to refund`,
        );
        continue;
      }
      const refund = await this.orders.insertDuplicatePurchaseRefund(trx, {
        orderId: input.orderId,
        orderLineId: line.id,
        userId: input.userId,
        amount: line.finalAmount,
      });
      await this.events.refundApproved(trx, {
        refundId: refund.refundId,
        orderId: input.orderId,
        orderLineId: line.id,
        initiatedBy: 'SYSTEM',
        approvedBy: null,
        approvedAt: refund.approvedAt.toISOString(),
      });
      duplicateRefundIds.push(refund.refundId);
      this.logger.warn(
        `order ${input.orderId}: course ${line.courseId} was already active; DUPLICATE_PURCHASE refund ${refund.refundId}`,
      );
    }
    await this.orders.removePurchasedFromCart(trx, {
      userId: input.userId,
      orderId: input.orderId,
      courseIds: lines.map((l) => l.courseId),
    });
    const paidLines = await this.orders.findPaidLines(input.orderId, trx);
    await this.events.orderPaid(trx, {
      orderId: input.orderId,
      orderNumber: header.orderNumber,
      userId: input.userId,
      currency: header.currency,
      totalAmount: header.totalAmount,
      provider: input.provider,
      paidAt: input.paidAt.toISOString(),
      lines: paidLines,
    });
    return { duplicateRefundIds };
  }

  /**
   * PENDING_PAYMENT -> EXPIRED / CANCELED (payment EXPIRED / ABANDONED, redemptions RELEASED)
   * and `OrderExpired` / `OrderCanceled`. The caller holds the locks and checked the status.
   */
  async close(trx: Transaction<DB>, userId: string, input: CloseOrderInput): Promise<Date> {
    const closedAt = await this.orders.closeOrder(trx, input);
    if (input.toStatus === 'EXPIRED') {
      if (input.cause === 'USER_CANCEL') throw new Error('an order cannot expire by USER_CANCEL');
      await this.events.orderExpired(trx, {
        orderId: input.orderId,
        userId,
        cause: input.cause,
        expiredAt: closedAt.toISOString(),
      });
    } else {
      if (input.cause === 'PROVIDER_EVENT') {
        throw new Error('an order is canceled by the buyer or the reconciler only');
      }
      await this.events.orderCanceled(trx, {
        orderId: input.orderId,
        userId,
        cause: input.cause,
        canceledAt: closedAt.toISOString(),
      });
    }
    return closedAt;
  }
}
