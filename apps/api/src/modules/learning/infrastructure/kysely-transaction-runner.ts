import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TransactionRunner } from '../application/ports/transaction-runner';
import { rethrowLearningConstraint } from './learning-constraint-errors';

/** READ COMMITTED (the pool default), as every learning transaction (schema doc §8). */
@Injectable()
export class KyselyTransactionRunner extends TransactionRunner {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().execute(work);
    } catch (error) {
      return rethrowLearningConstraint(error);
    }
  }
}
