import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TransactionRunner } from '../application/ports/transaction-runner';

/**
 * READ COMMITTED (the pool default) on purpose: the asset_usages triggers lock-then-recheck
 * (schema doc §6 item 5) and must see releases committed while they waited.
 */
@Injectable()
export class KyselyTransactionRunner extends TransactionRunner {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}
