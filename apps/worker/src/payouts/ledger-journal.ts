import { Injectable } from '@nestjs/common';
import {
  type DB,
  type PostRefundInput,
  type PostResult,
  postRefundEntry,
  type PostSaleInput,
  postSaleEntry,
  type Transaction,
} from '@udemy/db';
import { checkLedgerNow } from './ledger-errors';

/**
 * The ledger operations the writer uses, on the handler's transaction: the `@udemy/db` payouts
 * SQL (schema doc §1.13) plus the order read of schema doc §6 item 5. A class so the handlers
 * can be unit-tested with a fake.
 */
@Injectable()
export class LedgerJournal {
  postSale(trx: Transaction<DB>, input: PostSaleInput): Promise<PostResult> {
    return postSaleEntry(trx, input);
  }

  postRefund(trx: Transaction<DB>, input: PostRefundInput): Promise<PostResult> {
    return postRefundEntry(trx, input);
  }

  /** Runs the deferred balance / mirror triggers now (see checkLedgerNow). */
  checkNow(trx: Transaction<DB>): Promise<void> {
    return checkLedgerNow(trx);
  }

  /**
   * Whether the order ever reached PAID (`paid_at IS NOT NULL`); null when it does not exist.
   * Stands in for the `orderWasPaid` flag schema doc §6 item 5 asks for on `RefundSucceeded`
   * (not in the v1 contract): a PAYMENT_REVIEW -> REFUNDED order has no SALE to mirror.
   */
  async orderWasPaid(trx: Transaction<DB>, orderId: string): Promise<boolean | null> {
    const row = await trx
      .selectFrom('commerce.orders')
      .select('paidAt')
      .where('id', '=', orderId)
      .executeTakeFirst();
    return row === undefined ? null : row.paidAt !== null;
  }
}
