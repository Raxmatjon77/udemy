import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TransactionRunner } from '../application/ports/transaction-runner';
import { rethrowCommerceConstraint } from './commerce-constraint-errors';

/**
 * READ COMMITTED, set explicitly: the commerce lock-then-count steps and the coupon
 * reservation trigger need a fresh snapshot per statement (schema doc §6 R1; REPEATABLE READ
 * would let 20 parallel checkouts each count 0 reservations).
 *
 * Deferred constraints (`orders_total_ck`, `*_status_log_ck`, ...) raise at COMMIT, outside
 * every repository call, so the commit is mapped here as well (schema doc §7).
 */
@Injectable()
export class KyselyTransactionRunner extends TransactionRunner {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().setIsolationLevel('read committed').execute(work);
    } catch (error) {
      return rethrowCommerceConstraint(error);
    }
  }
}
