import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one READ COMMITTED transaction (commit on resolve, rollback on
 * throw). Commerce and enrollment run at READ COMMITTED (schema doc header): the grant upsert
 * relies on the row lock of `ON CONFLICT DO UPDATE`, not on snapshot isolation.
 *
 * Constraint violations, including the DEFERRED `enrollments_status_log_ck` raised at COMMIT,
 * are mapped like the statements (schema doc §9); unmapped ones stay a 500.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
