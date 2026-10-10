import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderError,
  PaymentProviderUnavailableError,
  type ProviderRefund,
  refundIdempotencyKey,
} from '@udemy/payments';
import { Money } from '../domain/money';
import { refundFailureCode } from '../domain/refund-policy';
import { CommerceSettings } from './commerce-settings';
import { CommerceClock } from './ports/commerce-clock';
import { type LeasedRefundRecord, RefundDispatchRepository } from './ports/refund.repository';
import { RefundDispatchTrigger } from './ports/provider-refund-events';
import { TransactionRunner } from './ports/transaction-runner';
import { RefundLifecycle } from './refund-lifecycle.service';

/** Schema doc §8.4. */
export const REFUND_DISPATCH_BATCH_SIZE = 25;
/** A lease older than this is a crashed dispatcher's: taken again (same idempotency key). */
export const REFUND_DISPATCH_STALE_LEASE_SECONDS = 120;
/** A kick that finds the dispatcher lock held retries this often before leaving it to the poll. */
const KICK_ATTEMPTS = 4;
const KICK_BACKOFF_MS = 250;

export interface RefundDispatchReport {
  /** false = another replica held `REFUND_DISPATCH_LOCK_KEY`; nothing was sent. */
  readonly locked: boolean;
  readonly leased: number;
  /** Provider answered pending: SUBMITTED, the webhook finishes it. */
  readonly submitted: number;
  /** Provider answered succeeded synchronously. */
  readonly succeeded: number;
  /** Provider refused (4xx) or answered failed: FAILED (admin alert, retry). */
  readonly failed: number;
  /** Provider unreachable / 5xx / unexpected error: lease given back, retried next run. */
  readonly released: number;
  /** tx2 found the lease gone (a webhook or another dispatcher got there first): no-op. */
  readonly lost: number;
}

type MutableReport = { -readonly [K in keyof RefundDispatchReport]: RefundDispatchReport[K] };

/**
 * `CommerceJobs.dispatchRefunds` (design D9, §5, schema doc §8.4): sends APPROVED refunds to
 * the provider exactly once in effect.
 *
 * 1. tx1 leases them (`pg_try_advisory_xact_lock(0x75646d79_03)`, `FOR UPDATE SKIP LOCKED`,
 *    `dispatch_started_at = now()`) and COMMITS, so no transaction is open during step 2;
 * 2. `createRefund` with the idempotency key `refund:{id}:{attempt}` (a re-run after a crash
 *    replays the same provider refund instead of creating a second one);
 * 3. tx2 writes SUBMITTED / SUCCEEDED / FAILED only if the lease still holds (status APPROVED,
 *    same attempt, same claim time); otherwise a webhook or another replica already did.
 *
 * Two replicas therefore never send the same refund attempt twice: the second either skips the
 * tick (advisory lock) or no longer sees the leased rows (a fresh `dispatch_started_at`).
 *
 * Also the post-commit kick (`RefundDispatchTrigger`): after a transaction approved refunds, it
 * dispatches exactly those at once (when `COMMERCE_JOBS_ENABLED`), instead of at the next poll.
 */
@Injectable()
export class RefundDispatcher implements OnApplicationShutdown {
  private readonly logger = new Logger(RefundDispatcher.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly dispatchRepo: RefundDispatchRepository,
    private readonly lifecycle: RefundLifecycle,
    private readonly settings: CommerceSettings,
    private readonly clock: CommerceClock,
    private readonly tx: TransactionRunner,
  ) {}

  /** One run: the oldest approvals (or exactly `refundIds`), sequentially. */
  async dispatch(
    options: { readonly refundIds?: readonly string[] } = {},
  ): Promise<RefundDispatchReport> {
    const lease = await this.dispatchRepo.lease({
      batchSize: REFUND_DISPATCH_BATCH_SIZE,
      staleLeaseSeconds: REFUND_DISPATCH_STALE_LEASE_SECONDS,
      ...(options.refundIds === undefined ? {} : { refundIds: options.refundIds }),
    });
    const report: MutableReport = {
      locked: lease.locked,
      leased: lease.refunds.length,
      submitted: 0,
      succeeded: 0,
      failed: 0,
      released: 0,
      lost: 0,
    };
    for (const refund of lease.refunds) {
      try {
        await this.send(refund, report);
      } catch (error) {
        // tx2 failed (database): the lease stays and goes stale; the next run replays the same
        // idempotency key, so the provider returns the same refund.
        report.released += 1;
        this.logger.error({ err: error }, `refund ${refund.id}: dispatch outcome not recorded`);
      }
    }
    if (report.leased > 0) this.logger.log(`dispatchRefunds: ${JSON.stringify(report)}`);
    return report;
  }

  /**
   * Post-commit kick: dispatch `refundIds` in the background (no-op when commerce jobs are
   * disabled in this process). Never throws; `whenIdle()` awaits the work.
   */
  kick(refundIds: readonly string[]): void {
    if (!this.settings.jobsEnabled || refundIds.length === 0) return;
    const ids = [...new Set(refundIds)];
    const work = this.kickWithRetry(ids)
      .catch((error: unknown) => {
        this.logger.error({ err: error }, `refund kick for ${ids.join(', ')} failed`);
      })
      .finally(() => {
        this.inFlight.delete(work);
      });
    this.inFlight.add(work);
  }

  /** Resolves when every kick started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  private async kickWithRetry(ids: readonly string[]): Promise<void> {
    for (let attempt = 1; attempt <= KICK_ATTEMPTS; attempt += 1) {
      const report = await this.dispatch({ refundIds: ids });
      if (report.locked) return;
      await sleep(KICK_BACKOFF_MS * attempt, undefined, { ref: false });
    }
    this.logger.log(`refund kick for ${ids.join(', ')}: dispatcher busy; left to the next poll`);
  }

  private async send(refund: LeasedRefundRecord, report: MutableReport): Promise<void> {
    const fence = {
      refundId: refund.id,
      orderId: refund.orderId,
      attempt: refund.attempt,
      claimedAt: refund.claimedAt,
    };
    if (refund.paymentIntentId === null) {
      // Impossible while refunds are only created on paid orders with a payment (amount > 0).
      await this.fail(refund, fence, 'no_payment_intent', report);
      return;
    }
    let result: ProviderRefund;
    try {
      result = await this.provider.createRefund(
        {
          paymentIntentId: refund.paymentIntentId,
          amountMinor: Money.fromDecimal(refund.amount, this.settings.currency).minor,
          refundId: refund.id,
          metadata: { orderId: refund.orderId },
        },
        { idempotencyKey: refundIdempotencyKey(refund.id, refund.attempt) },
      );
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        // A definitive refusal (4xx): FAILED, the admin decides (retry = a new attempt).
        this.logger.warn(
          `refund ${refund.id}: provider refused (${error.code}${error.providerCode === undefined ? '' : `/${error.providerCode}`})`,
        );
        const code = refundFailureCode(error.providerCode ?? error.code, 'provider_error');
        await this.fail(refund, fence, code, report);
        return;
      }
      if (!(error instanceof PaymentProviderUnavailableError)) {
        this.logger.error({ err: error }, `refund ${refund.id}: unexpected provider error`);
      } else {
        this.logger.warn(`refund ${refund.id}: payment provider unavailable; retried next run`);
      }
      await this.dispatchRepo.release({ refundId: refund.id, claimedAt: refund.claimedAt });
      report.released += 1;
      return;
    }
    if (result.status === 'FAILED') {
      await this.fail(
        refund,
        fence,
        refundFailureCode(result.failureReason, 'provider_failed'),
        report,
      );
      return;
    }
    const status = result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'SUBMITTED';
    const applied = await this.tx.run(async (trx) => {
      const done = await this.dispatchRepo.complete(trx, {
        ...fence,
        status,
        providerRefundId: result.providerRefundId,
      });
      if (done.applied && status === 'SUCCEEDED') await this.lifecycle.succeeded(trx, refund.id);
      return done.applied;
    });
    if (!applied) report.lost += 1;
    else if (status === 'SUCCEEDED') report.succeeded += 1;
    else report.submitted += 1;
  }

  private async fail(
    refund: LeasedRefundRecord,
    fence: { refundId: string; orderId: string; attempt: number; claimedAt: string },
    failureCode: string,
    report: MutableReport,
  ): Promise<void> {
    const applied = await this.tx.run(async (trx) => {
      const done = await this.dispatchRepo.fail(trx, { ...fence, failureCode });
      if (done.applied) {
        await this.lifecycle.failed(trx, {
          refundId: refund.id,
          orderId: refund.orderId,
          failureCode,
          attempt: refund.attempt,
          failedAt: await this.clock.now(trx),
        });
      }
      return done.applied;
    });
    if (applied) report.failed += 1;
    else report.lost += 1;
  }
}

/** `RefundDispatchTrigger` -> `RefundDispatcher.kick` (post-commit, fire and forget). */
@Injectable()
export class RefundDispatchKick extends RefundDispatchTrigger {
  constructor(private readonly dispatcher: RefundDispatcher) {
    super();
  }

  kick(refundIds: readonly string[]): void {
    this.dispatcher.kick(refundIds);
  }
}
