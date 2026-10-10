import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TransactionRunner } from '../application/ports/transaction-runner';
import { rethrowEnrollmentConstraint } from './enrollment-constraint-errors';

/**
 * READ COMMITTED (the pool default), as every commerce/enrollment transaction (schema doc
 * header). The deferred `enrollments_status_log_ck` raises at COMMIT, outside every repository
 * call, so the commit is mapped here as well (it stays a 500: a programming error).
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
      return rethrowEnrollmentConstraint(error);
    }
  }
}
