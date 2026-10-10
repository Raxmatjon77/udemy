/**
 * Reconciler candidates (docs/phase-4-schema-design.md §8.5, R2), for the API's
 * CommerceJobs.reconcile (every 5 min). Take `COMMERCE_RECONCILE_LOCK_KEY` (`_04`) with
 * `tryAdvisoryXactLock` per batch. What to do with each candidate (replay/expire/retrieve at the
 * provider, then the PAID path `markOrderPaid` or the cancel/expire path) is the use case's job.
 */
import { sql } from 'kysely';
import { assertBatchSize, assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

export interface StaleCreatingPayment {
  orderId: string;
  userId: string;
  /** Stored at tx A; replay the create with exactly this value (Stripe idempotent replay). */
  sessionExpiresAt: Date;
  createdAt: Date;
}

/** (a) payments stuck in CREATING for more than `olderThanMinutes` (default 15), oldest first. */
export async function findStaleCreatingPayments(
  executor: Executor,
  options: { batchSize: number; olderThanMinutes?: number },
): Promise<StaleCreatingPayment[]> {
  assertBatchSize(options.batchSize);
  const minutes = options.olderThanMinutes ?? 15;
  assertIntInRange('olderThanMinutes', minutes, 1, 10_080);
  const { rows } = await sql<StaleCreatingPayment>`
    SELECT p.order_id, o.user_id, p.session_expires_at, p.created_at
      FROM commerce.payments p JOIN commerce.orders o ON o.id = p.order_id
     WHERE p.status = 'CREATING' AND p.created_at < now() - make_interval(mins => ${minutes})
     ORDER BY p.created_at
     LIMIT ${options.batchSize}
  `.execute(executor);
  return rows;
}

export interface OverdueOpenSession {
  orderId: string;
  userId: string;
  checkoutSessionId: string;
  sessionExpiresAt: Date;
}

/** (b) OPEN sessions whose expires_at passed more than `graceMinutes` (default 10) ago. */
export async function findOverdueOpenSessions(
  executor: Executor,
  options: { batchSize: number; graceMinutes?: number },
): Promise<OverdueOpenSession[]> {
  assertBatchSize(options.batchSize);
  const minutes = options.graceMinutes ?? 10;
  assertIntInRange('graceMinutes', minutes, 0, 10_080);
  const { rows } = await sql<OverdueOpenSession>`
    SELECT p.order_id, o.user_id, p.checkout_session_id, p.session_expires_at
      FROM commerce.payments p JOIN commerce.orders o ON o.id = p.order_id
     WHERE p.status = 'OPEN' AND p.session_expires_at < now() - make_interval(mins => ${minutes})
     ORDER BY p.session_expires_at
     LIMIT ${options.batchSize}
  `.execute(executor);
  return rows;
}
