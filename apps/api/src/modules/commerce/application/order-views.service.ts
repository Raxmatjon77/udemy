import { Injectable } from '@nestjs/common';
import type { OrderDetail, OrderSummary, Receipt } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { OrderNotFound, OrderNotPaid } from '../domain/commerce.errors';
import { Money } from '../domain/money';
import { lineRefundState } from '../domain/order-line-refund-state';
import { CommerceSettings } from './commerce-settings';
import { CommerceClock } from './ports/commerce-clock';
import { CommerceBuyers, CommerceCatalog, CommercePeople } from './ports/context-gateways';
import {
  type OrderDetailRecord,
  OrderRepository,
  type OrderSummaryRecord,
} from './ports/order.repository';
import { TransactionRunner } from './ports/transaction-runner';

function sum(amounts: readonly string[], currency: string): string {
  return Money.sum(
    amounts.map((a) => Money.fromDecimal(a, currency)),
    currency,
  ).toDecimal();
}

/**
 * The buyer's order views (design §5 `GetMyOrder` / `GetReceipt`, §8): always scoped to the
 * viewer, so a foreign order is 404 even for a principal whose policy passed through
 * `order:read:any` (§9 IDOR; `/me` routes are the buyer's own). Each view is read in one
 * transaction (one snapshot, the database clock for the refund window).
 */
@Injectable()
export class OrderViews {
  constructor(
    private readonly orders: OrderRepository,
    private readonly catalog: CommerceCatalog,
    private readonly people: CommercePeople,
    private readonly buyers: CommerceBuyers,
    private readonly clock: CommerceClock,
    private readonly settings: CommerceSettings,
    private readonly tx: TransactionRunner,
  ) {}

  /** @throws OrderNotFound (404) for an unknown or foreign order */
  detail(orderId: string, viewerId: string): Promise<OrderDetail> {
    return this.tx.run(async (trx) => {
      const order = await this.mine(orderId, viewerId, trx);
      return this.toDetail(order, trx);
    });
  }

  /**
   * @throws OrderNotFound (404) for an unknown or foreign order
   * @throws OrderNotPaid (409 `order_not_paid`) before the order was paid
   */
  receipt(orderId: string, viewerId: string): Promise<Receipt> {
    return this.tx.run(async (trx) => {
      const order = await this.mine(orderId, viewerId, trx);
      if (order.paidAt === null) throw new OrderNotPaid();
      const buyer = await this.buyers.findBuyer(order.userId, trx);
      const currency = order.currency;
      return {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        issuedAt: order.paidAt.toISOString(),
        buyer: { displayName: buyer?.displayName ?? '' },
        currency: Money.zero(currency).currency,
        lines: order.lines.map((l) => ({
          courseTitle: l.courseTitle,
          listAmount: l.listAmount,
          discountAmount: l.discountAmount,
          finalAmount: l.finalAmount,
          couponCode: l.couponCode,
        })),
        subtotalAmount: sum(
          order.lines.map((l) => l.listAmount),
          currency,
        ),
        discountAmount: sum(
          order.lines.map((l) => l.discountAmount),
          currency,
        ),
        totalAmount: order.totalAmount,
        refundedAmount: order.refundedAmount,
        paymentProvider: order.payment === null ? 'NONE' : 'STRIPE',
      };
    });
  }

  summary(order: OrderSummaryRecord): OrderSummary {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: Money.zero(order.currency).currency,
      totalAmount: order.totalAmount,
      lineCount: order.lineCount,
      courseTitles: [...order.courseTitles],
      placedAt: order.placedAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }

  private async mine(orderId: string, viewerId: string, ex: Executor): Promise<OrderDetailRecord> {
    const order = await this.orders.findDetail(orderId, ex);
    if (order?.userId !== viewerId) throw new OrderNotFound();
    return order;
  }

  private async toDetail(order: OrderDetailRecord, ex: Executor): Promise<OrderDetail> {
    const now = await this.clock.now(ex);
    const currency = Money.zero(order.currency).currency;
    // Sequential: one transaction is one connection.
    const people = await this.people.findPeople(
      [...new Set(order.lines.map((l) => l.instructorId))],
      ex,
    );
    const courses = await this.catalog.getCourses(
      order.lines.map((l) => l.courseId),
      ex,
    );
    const slugs = new Map(courses.map((c) => [c.id, c.slug]));
    const open = order.status === 'PENDING_PAYMENT' && order.payment?.status === 'OPEN';
    return {
      id: order.orderId,
      orderNumber: order.orderNumber,
      status: order.status,
      currency,
      subtotalAmount: sum(
        order.lines.map((l) => l.listAmount),
        currency,
      ),
      discountAmount: sum(
        order.lines.map((l) => l.discountAmount),
        currency,
      ),
      totalAmount: order.totalAmount,
      refundedAmount: order.refundedAmount,
      placedAt: order.placedAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      closedAt: order.closedAt?.toISOString() ?? null,
      lines: order.lines.map((line) => {
        const person = people.get(line.instructorId);
        const refund = lineRefundState({
          orderStatus: order.status,
          paidAt: order.paidAt,
          finalMinor: Money.fromDecimal(line.finalAmount, currency).minor,
          latestRefund: line.latestRefund,
          now,
          refundWindowDays: this.settings.refundWindowDays,
        });
        return {
          id: line.id,
          lineNo: line.lineNo,
          courseId: line.courseId,
          slug: slugs.get(line.courseId) ?? null,
          courseTitle: line.courseTitle,
          instructor:
            person === undefined || person.banned
              ? null
              : { id: line.instructorId, displayName: person.displayName },
          listAmount: line.listAmount,
          discountAmount: line.discountAmount,
          finalAmount: line.finalAmount,
          couponCode: line.couponCode,
          refund: {
            refundId: refund.refundId,
            status: refund.status,
            refundableUntil: refund.refundableUntil?.toISOString() ?? null,
            eligible: refund.eligible,
            reason: refund.reason,
          },
        };
      }),
      payment: {
        provider: order.payment === null ? 'NONE' : 'STRIPE',
        status: order.payment?.status ?? null,
      },
      checkoutUrl: open ? (order.payment?.checkoutUrl ?? null) : null,
    };
  }
}
