import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

/** The purchased line a refund belongs to, as snapshotted at checkout. */
export interface RefundMailContext {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly courseTitle: string;
  readonly amount: string;
  readonly currency: string;
}

/**
 * Commerce facts the mails need but the events don't carry (the refund events have ids and
 * amounts only). Read in the handler's transaction; null when the row is gone. Course titles
 * come from the `order_lines` snapshot (what was sold), not from the live catalog.
 */
@Injectable()
export class CommerceMailReader {
  async refund(trx: Transaction<DB>, refundId: string): Promise<RefundMailContext | null> {
    const row = await trx
      .selectFrom('commerce.refunds as r')
      .innerJoin('commerce.orderLines as l', 'l.id', 'r.orderLineId')
      .innerJoin('commerce.orders as o', 'o.id', 'r.orderId')
      .select(['o.id as orderId', 'o.orderNumber', 'l.courseTitle', 'r.amount', 'o.currency'])
      .where('r.id', '=', refundId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** The human order number for admin alerts (the events carry only the order id). */
  async orderNumber(trx: Transaction<DB>, orderId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('commerce.orders')
      .select('orderNumber')
      .where('id', '=', orderId)
      .executeTakeFirst();
    return row?.orderNumber ?? null;
  }
}
