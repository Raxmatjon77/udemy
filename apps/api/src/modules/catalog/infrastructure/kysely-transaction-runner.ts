import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TransactionRunner } from '../application/ports/transaction-runner';
import { rethrowCatalogConstraint } from './catalog-constraint-errors';

/**
 * READ COMMITTED (the pool default) on purpose: MediaFacade's usage triggers lock-then-recheck
 * (schema doc §6 item 5) inside catalog's transactions.
 *
 * Deferred constraints (`*_position_uq`, `courses_status_log_ck`, ...) raise at COMMIT, i.e.
 * outside every repository call, so the commit is mapped here as well (schema doc §7).
 */
@Injectable()
export class KyselyTransactionRunner extends TransactionRunner {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().execute(work);
    } catch (error) {
      return rethrowCatalogConstraint(error);
    }
  }
}
