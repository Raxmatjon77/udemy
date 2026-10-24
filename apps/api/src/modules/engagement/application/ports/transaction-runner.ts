import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one READ COMMITTED transaction (commit on resolve, rollback on
 * throw). Every engagement path runs at READ COMMITTED (schema doc §8): the upserts rely on the
 * row locks of `ON CONFLICT DO UPDATE`, reports on the subject row lock (R9), the wishlist cap
 * on the `wish` advisory lock.
 *
 * Constraint violations, including the DEFERRED `moderation_status_log_ck` raised at COMMIT,
 * are mapped like the statements (schema doc §9); unmapped ones stay a 500.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
