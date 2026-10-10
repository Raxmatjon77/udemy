import { type DB, sql, type Transaction } from '@udemy/db';
import { NonRetryableError } from '../messaging';

/**
 * A `RefundSucceeded` arrived before the line's SALE entry (`journal_entries_sale_missing_ck`,
 * schema doc §1.13 / §9). Refund events share the order's partition, so this means the
 * `OrderPaid` is still in flight or was dead-lettered: a plain (retryable) error, so the
 * dispatcher retries with backoff and dead-letters after WORKER_MAX_RETRIES. A DLQ replay after
 * the SALE is posted then succeeds.
 */
export class LedgerSaleMissingError extends Error {
  constructor(
    readonly orderLineId: string,
    readonly refundId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `No SALE entry for order line ${orderLineId} yet (refund ${refundId}); will retry`,
      options,
    );
    this.name = new.target.name;
  }
}

interface PgErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/** The `constraint` of a Postgres error with the given SQLSTATE, else undefined. */
export function pgConstraint(error: unknown, sqlState: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as PgErrorFields;
  return code === sqlState && typeof constraint === 'string' ? constraint : undefined;
}

export function isSaleMissing(error: unknown): boolean {
  return pgConstraint(error, '23514') === 'journal_entries_sale_missing_ck';
}

/**
 * Invariants of a posted entry that no retry can fix: unbalanced postings, a REFUND that is
 * not the exact mirror of its SALE, an account or entry currency mismatch.
 */
const PERMANENT_LEDGER_CONSTRAINTS = new Set([
  'postings_balanced_ck',
  'journal_entries_mirror_ck',
  'postings_entry_id_currency_fk',
  'postings_account_id_currency_fk',
  'postings_amount_ck',
  'accounts_owner_id_fk',
]);

/** Maps a ledger invariant violation to NonRetryableError (DLQ at once); anything else is rethrown. */
export function classifyLedgerError(error: unknown): unknown {
  const constraint = pgConstraint(error, '23514') ?? pgConstraint(error, '23503');
  if (constraint !== undefined && PERMANENT_LEDGER_CONSTRAINTS.has(constraint)) {
    return new NonRetryableError(`Ledger invariant violated (${constraint})`, { cause: error });
  }
  return error;
}

/**
 * Runs the deferred balance and mirror triggers now instead of at COMMIT, so a violation is
 * raised inside the handler (and classified there) rather than by the processor's commit, where
 * it would look like a transient failure and burn the retry budget.
 */
export async function checkLedgerNow(trx: Transaction<DB>): Promise<void> {
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);
}
