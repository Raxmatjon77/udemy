import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one database transaction (commit on resolve, rollback on
 * throw). Repositories and the outbox publisher receive the `trx` explicitly.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
