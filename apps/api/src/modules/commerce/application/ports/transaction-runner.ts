import type { DB, Transaction } from '@udemy/db';

/**
 * Unit of work: runs `work` in one **READ COMMITTED** transaction (commit on resolve, rollback
 * on throw). READ COMMITTED is required, not a default (schema doc header and §6 R1): the
 * coupon reservation trigger and every lock-then-count step rely on each statement taking a
 * fresh snapshot.
 *
 * Constraint violations, including the DEFERRED ones raised at COMMIT (`orders_total_ck`,
 * `*_status_log_ck`, ...), surface as commerce domain errors through the constraint map
 * (schema doc §9); unknown ones stay 500s.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
}
