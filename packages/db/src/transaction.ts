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
