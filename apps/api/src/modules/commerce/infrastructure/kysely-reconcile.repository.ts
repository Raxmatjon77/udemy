import { Injectable } from '@nestjs/common';
import {
  COMMERCE_RECONCILE_LOCK_KEY,
  type DB,
  type Executor,
  findOverdueOpenSessions,
  findStaleCreatingPayments,
  type Transaction,
  tryAdvisoryXactLock,
} from '@udemy/db';
import {
  type OverdueOpenSessionRecord,
  ReconcileRepository,
  type StaleCreatingPaymentRecord,
} from '../application/ports/reconcile.repository';

/** Reconciler candidates through the `@udemy/db` ops (schema doc §8.5). */
@Injectable()
export class KyselyReconcileRepository extends ReconcileRepository {
  tryLock(trx: Transaction<DB>): Promise<boolean> {
    return tryAdvisoryXactLock(trx, COMMERCE_RECONCILE_LOCK_KEY);
  }

  async findStaleCreating(
    ex: Executor,
    options: { batchSize: number; olderThanMinutes: number },
  ): Promise<StaleCreatingPaymentRecord[]> {
    const rows = await findStaleCreatingPayments(ex, options);
    return rows.map((r) => ({ orderId: r.orderId, userId: r.userId }));
  }

  async findOverdueOpen(
    ex: Executor,
    options: { batchSize: number; graceMinutes: number },
  ): Promise<OverdueOpenSessionRecord[]> {
    const rows = await findOverdueOpenSessions(ex, options);
    return rows.map((r) => ({
      orderId: r.orderId,
      userId: r.userId,
      checkoutSessionId: r.checkoutSessionId,
    }));
  }
}
