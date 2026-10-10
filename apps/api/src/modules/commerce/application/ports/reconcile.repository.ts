import type { DB, Executor, Transaction } from '@udemy/db';

export interface StaleCreatingPaymentRecord {
  readonly orderId: string;
  readonly userId: string;
}

export interface OverdueOpenSessionRecord {
  readonly orderId: string;
  readonly userId: string;
  readonly checkoutSessionId: string;
}

/**
 * Reconciler candidates (schema doc §8.5, R2). Selected in a short transaction holding
 * `COMMERCE_RECONCILE_LOCK_KEY` (`0x75646d79_04`); every effect afterwards is idempotent and
 * state-guarded, so two replicas never double-apply.
 */
export abstract class ReconcileRepository {
  /** `pg_try_advisory_xact_lock(_04)`; false = another replica runs this tick. */
  abstract tryLock(trx: Transaction<DB>): Promise<boolean>;

  /** (a) payments CREATING for more than `olderThanMinutes` (15), oldest first. */
  abstract findStaleCreating(
    ex: Executor,
    options: { readonly batchSize: number; readonly olderThanMinutes: number },
  ): Promise<StaleCreatingPaymentRecord[]>;

  /** (b) OPEN sessions whose `expires_at` passed more than `graceMinutes` (10) ago. */
  abstract findOverdueOpen(
    ex: Executor,
    options: { readonly batchSize: number; readonly graceMinutes: number },
  ): Promise<OverdueOpenSessionRecord[]>;
}
