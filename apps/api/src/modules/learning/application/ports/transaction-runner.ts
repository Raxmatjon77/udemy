import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one READ COMMITTED transaction (commit on resolve, rollback on
 * throw). Every learning transaction runs at READ COMMITTED (schema doc §8): the completion
 * mutex is the `lrnc` advisory lock, taken first, with the reads in later statements (R1).
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
