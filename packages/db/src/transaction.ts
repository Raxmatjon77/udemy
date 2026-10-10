import type { Kysely, Transaction } from 'kysely';
import type { DB } from './generated/db';

/** Anything that can run queries: the root db or an open transaction. */
export type Executor = Kysely<DB> | Transaction<DB>;

/** Runs `fn` in a transaction; commits on resolve, rolls back on throw. */
export function withTransaction<T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(fn);
}

/**
 * Runs `fn` in the caller's transaction when `executor` is one, else in a new transaction.
 * For multi-statement operations that must be atomic (e.g. transcoder lease/complete). Pass
 * your own transaction when you also write an outbox event that must commit with them.
 */
export function inTransaction<T>(
  executor: Executor,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (executor.isTransaction) return fn(executor as Transaction<DB>);
  return executor.transaction().execute(fn);
}

/** Throws unless `executor` is an open transaction (row/advisory locks would be released at once). */
export function requireTransaction(executor: Executor, what: string): Transaction<DB> {
  if (!executor.isTransaction) {
    throw new TypeError(`${what} must run inside a transaction (its locks are transaction-scoped)`);
  }
  return executor as Transaction<DB>;
}
