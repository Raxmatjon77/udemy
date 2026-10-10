import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one READ COMMITTED transaction (the usage triggers rely on it,
 * schema doc §6 item 5). Commit on resolve, rollback on throw.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
