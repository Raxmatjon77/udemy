import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one READ COMMITTED transaction (commit on resolve, rollback on
 * throw). READ COMMITTED is required by media's usage triggers (schema doc §6 item 5), which
 * run inside catalog's transactions through MediaFacade.
 *
 * Constraint violations, including the DEFERRED ones raised at COMMIT (position uniques,
 * `courses_status_log_ck`), surface as catalog domain errors (schema doc §9).
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
