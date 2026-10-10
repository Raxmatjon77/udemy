import { Injectable } from '@nestjs/common';
import type {
  OrderStatus,
  OrderTransitionCause,
  PaymentStatus,
  ProviderEventOutcome,
} from '@udemy/contracts';
import { type Executor, sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type AdminOrderFilter,
  type AdminOrderLineRecord,
  type AdminOrderParts,
  AdminOrderRepository,
  type AdminOrderRowRecord,
  type AdminPaymentRecord,
} from '../application/ports/admin-order.repository';
import type { OrderKeyset } from '../application/ports/order.repository';

function orderNumberOf(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Invalid order number ${value}`);
  return n;
}

/** Admin order search and detail parts (read-only; indexes of schema doc §6). */
@Injectable()
export class KyselyAdminOrderRepository extends AdminOrderRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async search(
    filter: AdminOrderFilter,
    page: { after?: OrderKeyset; limit: number },
    ex: Executor = this.db,
  ): Promise<AdminOrderRowRecord[]> {
    if (filter.userIdIn?.length === 0) return [];
    const conditions = [
      filter.orderNumber === undefined ? null : sql`o.order_number = ${filter.orderNumber}`,
      filter.status === undefined ? null : sql`o.status = ${filter.status}`,
      filter.userId === undefined ? null : sql`o.user_id = ${filter.userId}`,
      filter.userIdIn === undefined ? null : sql`o.user_id = ANY(${[...filter.userIdIn]}::uuid[])`,
      filter.courseId === undefined
        ? null
        : sql`EXISTS (SELECT 1 FROM commerce.order_lines l
                       WHERE l.order_id = o.id AND l.course_id = ${filter.courseId})`,
      filter.from === undefined ? null : sql`o.placed_at >= ${filter.from}`,
      filter.to === undefined ? null : sql`o.placed_at < ${filter.to}`,
      page.after === undefined
        ? null
        : sql`(o.placed_at, o.id) < (${page.after.placedAt}::timestamptz, ${page.after.id}::uuid)`,
    ].filter((c) => c !== null);
    const where = conditions.length === 0 ? sql`true` : sql.join(conditions, sql` AND `);
    const { rows } = await sql<{
      id: string;
      orderNumber: string;
      userId: string;
      status: OrderStatus;
      currency: string;
      totalAmount: string;
      lineCount: number;
      placedAt: Date;
      placedAtText: string;
      paidAt: Date | null;
    }>`
      SELECT o.id, o.order_number, o.user_id, o.status, o.currency, o.total_amount, o.placed_at,
             to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS placed_at_text,
             o.paid_at,
             (SELECT count(*)::int FROM commerce.order_lines l WHERE l.order_id = o.id) AS line_count
        FROM commerce.orders o
       WHERE ${where}
       ORDER BY o.placed_at DESC, o.id DESC
       LIMIT ${page.limit}
    `.execute(ex);
    return rows.map((row) => ({
      id: row.id,
      orderNumber: orderNumberOf(row.orderNumber),
      userId: row.userId,
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount,
      lineCount: row.lineCount,
      placedAt: row.placedAt,
      paidAt: row.paidAt,
      keyset: { placedAt: row.placedAtText, id: row.id },
    }));
  }

  async findParts(orderId: string, ex: Executor = this.db): Promise<AdminOrderParts> {
    const { rows: lines } = await sql<AdminOrderLineRecord>`
      SELECT l.id, l.line_no, l.course_id, l.course_title, l.instructor_id, l.list_amount,
             l.discount_amount, l.final_amount, l.coupon_id, c.code AS coupon_code,
             l.revenue_share_bps, l.instructor_share_amount, l.platform_share_amount
        FROM commerce.order_lines l
        LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
       WHERE l.order_id = ${orderId}
       ORDER BY l.line_no
    `.execute(ex);
    const payment = await ex
      .selectFrom('commerce.payments')
      .select([
        'status',
        'amount',
        'currency',
        'checkoutSessionId',
        'paymentIntentId',
        'sessionExpiresAt',
        'succeededAt',
        'createdAt',
        'updatedAt',
      ])
      .where('orderId', '=', orderId)
      .executeTakeFirst();
    const transitions = await ex
      .selectFrom('commerce.orderTransitions')
      .select([
        'seq',
        'fromStatus',
        'toStatus',
        'cause',
        'providerEventId',
        'actorId',
        'reason',
        'occurredAt',
      ])
      .where('orderId', '=', orderId)
      .orderBy('seq')
      .execute();
    const events = await ex
      .selectFrom('commerce.providerEvents')
      .select([
        'eventId',
        'type',
        'livemode',
        'objectId',
        'providerCreatedAt',
        'receivedAt',
        'processedAt',
        'outcome',
      ])
      .where('orderId', '=', orderId)
      .orderBy('receivedAt')
      .orderBy('eventId')
      .execute();
    return {
      lines,
      payment:
        payment === undefined
          ? null
          : ({ ...payment, status: payment.status as PaymentStatus } satisfies AdminPaymentRecord),
      transitions: transitions.map((t) => ({
        ...t,
        fromStatus: t.fromStatus as OrderStatus | null,
        toStatus: t.toStatus as OrderStatus,
        cause: t.cause as OrderTransitionCause,
      })),
      providerEvents: events.map((e) => ({
        ...e,
        outcome: e.outcome as ProviderEventOutcome | null,
      })),
    };
  }
}
