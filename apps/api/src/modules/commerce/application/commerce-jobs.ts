import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderUnavailableError,
} from '@udemy/payments';
import { CreatingPaymentAbandoner } from './creating-payment-abandoner.service';
import { CommerceClock } from './ports/commerce-clock';
import {
  type OverdueOpenSessionRecord,
  ReconcileRepository,
  type StaleCreatingPaymentRecord,
} from './ports/reconcile.repository';
import { TransactionRunner } from './ports/transaction-runner';
import { syntheticCheckoutEvent } from './synthetic-provider-event';
import { HandleProviderEventCommand } from './use-cases/handle-provider-event.command';

/** Schema doc §8.5. */
export const RECONCILE_STALE_CREATING_MINUTES = 15;
export const RECONCILE_OVERDUE_GRACE_MINUTES = 10;
export const RECONCILE_BATCH_SIZE = 50;

export interface ReconcileReport {
  /** false = another replica held `COMMERCE_RECONCILE_LOCK_KEY`; nothing was done. */
  readonly locked: boolean;
  /** (a) CREATING orders canceled (payment ABANDONED). */
  readonly abandoned: number;
  /** Sessions found complete+paid and applied as PAID (from (a) or (b)). */
  readonly completed: number;
  /** (b) OPEN sessions applied as EXPIRED. */
  readonly expired: number;
  /** Candidates left for the next tick (provider unreachable, still open unpaid, ...). */
  readonly skipped: number;
}

/**
 * API-side commerce jobs (design D9). `reconcile` (every `COMMERCE_RECONCILE_INTERVAL_MS`):
 *
 * - (a) payments CREATING for more than 15 min (tx B never ran): replay the create with the
 *   same key and stored `expires_at`, expire the session, ABANDONED + CANCELED; a session
 *   that turns out complete is applied as PAID instead;
 * - (b) OPEN sessions more than 10 min past `expires_at`: `retrieve()` and apply the
 *   provider's authoritative answer through the SAME `HandleProviderEvent` path as the
 *   webhook, with synthetic event ids `reconcile:{sessionId}:{COMPLETED|EXPIRED}` (a session
 *   still open is expired first). A missed or late webhook therefore cannot leave an order
 *   PENDING forever, and a webhook arriving afterwards is a DUPLICATE_EFFECT (R2).
 *
 * Candidates are selected in a short transaction holding `COMMERCE_RECONCILE_LOCK_KEY`
 * (`0x75646d79_04`); no transaction is held across a provider call. P4-T16 adds
 * `dispatchRefunds` (lock `_03`) here.
 */
@Injectable()
export class CommerceJobs {
  private readonly logger = new Logger(CommerceJobs.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly reconcileRepo: ReconcileRepository,
    private readonly abandoner: CreatingPaymentAbandoner,
    private readonly handleEvent: HandleProviderEventCommand,
    private readonly clock: CommerceClock,
    private readonly tx: TransactionRunner,
  ) {}

  async reconcile(): Promise<ReconcileReport> {
    const candidates = await this.tx.run(async (trx) => {
      if (!(await this.reconcileRepo.tryLock(trx))) return null;
      const stale = await this.reconcileRepo.findStaleCreating(trx, {
        batchSize: RECONCILE_BATCH_SIZE,
        olderThanMinutes: RECONCILE_STALE_CREATING_MINUTES,
      });
      const overdue = await this.reconcileRepo.findOverdueOpen(trx, {
        batchSize: RECONCILE_BATCH_SIZE,
        graceMinutes: RECONCILE_OVERDUE_GRACE_MINUTES,
      });
      return { stale, overdue };
    });
    if (candidates === null) {
      return { locked: false, abandoned: 0, completed: 0, expired: 0, skipped: 0 };
    }

    const report = { locked: true, abandoned: 0, completed: 0, expired: 0, skipped: 0 };
    for (const payment of candidates.stale) {
      await this.guarded(payment.orderId, report, () => this.abandonStale(payment, report));
    }
    for (const session of candidates.overdue) {
      await this.guarded(session.orderId, report, () => this.settleOverdue(session, report));
    }
    if (report.abandoned + report.completed + report.expired + report.skipped > 0) {
      this.logger.log(`reconcile: ${JSON.stringify(report)}`);
    }
    return report;
  }

  /** One candidate's failure never stops the batch; it is retried at the next tick. */
  private async guarded(
    orderId: string,
    report: { skipped: number },
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      report.skipped += 1;
      if (error instanceof PaymentProviderUnavailableError) {
        this.logger.warn(`reconcile: order ${orderId} skipped, payment provider unavailable`);
      } else {
        this.logger.error({ err: error }, `reconcile: order ${orderId} failed`);
      }
    }
  }

  private async abandonStale(
    payment: StaleCreatingPaymentRecord,
    report: { abandoned: number; completed: number; skipped: number },
  ): Promise<void> {
    const outcome = await this.abandoner.abandon(
      payment.orderId,
      { kind: 'RECONCILER' },
      { bestEffort: false },
    );
    if (outcome === 'CANCELED') report.abandoned += 1;
    else if (outcome === 'COMPLETED') report.completed += 1;
    else report.skipped += 1;
  }

  private async settleOverdue(
    session: OverdueOpenSessionRecord,
    report: { completed: number; expired: number; skipped: number },
  ): Promise<void> {
    let current = await this.provider.retrieveCheckoutSession(session.checkoutSessionId);
    if (current.status === 'open') {
      // Past our expiry but still open at the provider (clock skew, a missed sweep): close it.
      // ALREADY_COMPLETE means it was paid meanwhile: the re-read below applies that.
      await this.provider.expireCheckoutSession(session.checkoutSessionId);
      current = await this.provider.retrieveCheckoutSession(session.checkoutSessionId);
    }
    const now = await this.tx.run((trx) => this.clock.now(trx));
    if (current.status === 'complete' && current.paymentStatus === 'paid') {
      const { event, payloadSha256 } = syntheticCheckoutEvent(current, 'COMPLETED', now);
      await this.handleEvent.execute(event, payloadSha256, 'RECONCILER');
      report.completed += 1;
      return;
    }
    if (current.status === 'expired') {
      const { event, payloadSha256 } = syntheticCheckoutEvent(current, 'EXPIRED', now);
      await this.handleEvent.execute(event, payloadSha256, 'RECONCILER');
      report.expired += 1;
      return;
    }
    // complete but unpaid (an async method, impossible with cards only): leave it, log it.
    this.logger.warn(
      `reconcile: session ${session.checkoutSessionId} of order ${session.orderId} is ${current.status}/${current.paymentStatus}`,
    );
    report.skipped += 1;
  }
}
