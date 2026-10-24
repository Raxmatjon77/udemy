import { randomUUID } from 'node:crypto';
import type { DB, Executor, Transaction } from '@udemy/db';
import {
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  type PaymentProvider,
  type ProviderRefund,
} from '@udemy/payments';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderTransitionId } from './admin-order-views.service';
import { CommerceSettings } from './commerce-settings';
import type { CommerceClock } from './ports/commerce-clock';
import type { LeasedRefundRecord, RefundDispatchRepository } from './ports/refund.repository';
import type { TransactionRunner } from './ports/transaction-runner';
import { RefundDispatcher, RefundDispatchKick } from './refund-dispatcher.service';
import type { RefundLifecycle } from './refund-lifecycle.service';

const trx = {} as Transaction<DB>;
const tx: TransactionRunner = { run: (work) => work(trx) };
const clock: CommerceClock = {
  now: (_ex: Executor) => Promise.resolve(new Date('2026-10-10T12:00:00Z')),
};

function settings(jobsEnabled: boolean): CommerceSettings {
  return CommerceSettings.fromEnv({
    COMMERCE_CURRENCY: 'USD',
    COMMERCE_CART_MAX_ITEMS: 20,
    COMMERCE_INSTRUCTOR_SHARE_BPS: 7000,
    COMMERCE_CHECKOUT_SESSION_TTL_MIN: 35,
    COMMERCE_REFUND_WINDOW_DAYS: 30,
    COMMERCE_REFUND_REVIEW_CONSUMED_PCT: 30,
    COMMERCE_JOBS_ENABLED: jobsEnabled,
    COMMERCE_RECONCILE_INTERVAL_MS: 300_000,
    COMMERCE_REFUND_DISPATCH_INTERVAL_MS: 60_000,
    STUDENT_APP_ORIGIN: 'http://localhost:3000',
    STRIPE_WEBHOOK_SECRET: 'whsec_unit',
    STRIPE_WEBHOOK_TOLERANCE_S: 300,
  });
}

function leased(overrides: Partial<LeasedRefundRecord> = {}): LeasedRefundRecord {
  return {
    id: randomUUID(),
    orderId: randomUUID(),
    orderLineId: randomUUID(),
    amount: '19.99',
    attempt: 1,
    claimedAt: '2026-10-10 12:00:00.123456+00',
    paymentIntentId: 'pi_unit',
    ...overrides,
  };
}

function providerRefund(status: ProviderRefund['status']): ProviderRefund {
  return {
    providerRefundId: 're_unit',
    status,
    providerStatus: status.toLowerCase(),
    refundId: null,
    paymentIntentId: 'pi_unit',
    amountMinor: 1999,
    currency: 'USD',
    failureReason: status === 'FAILED' ? 'lost_or_stolen_card' : null,
  };
}

function harness(
  options: { jobsEnabled?: boolean; refunds?: LeasedRefundRecord[]; locked?: boolean } = {},
) {
  const refunds = options.refunds ?? [leased()];
  const repo = {
    lease: vi.fn(async () => ({ locked: options.locked ?? true, refunds })),
    complete: vi.fn(async () => ({ applied: true })),
    fail: vi.fn(async () => ({ applied: true })),
    release: vi.fn(async () => true),
  };
  const provider = { createRefund: vi.fn(async () => providerRefund('PENDING')) };
  const lifecycle = {
    succeeded: vi.fn(async () => undefined),
    failed: vi.fn(async () => undefined),
  };
  const dispatcher = new RefundDispatcher(
    provider as unknown as PaymentProvider,
    repo as unknown as RefundDispatchRepository,
    lifecycle as unknown as RefundLifecycle,
    settings(options.jobsEnabled ?? true),
    clock,
    tx,
  );
  return { dispatcher, repo, provider, lifecycle, refunds };
}

afterEach(() => vi.restoreAllMocks());

describe('RefundDispatcher (D9, schema doc §8.4)', () => {
  it('provider call with refund:{id}:{attempt}, outside any transaction; pending -> SUBMITTED', async () => {
    const refund = leased({ attempt: 3 });
    const h = harness({ refunds: [refund] });
    const order: string[] = [];
    h.repo.lease.mockImplementation(async () => {
      order.push('lease');
      return { locked: true, refunds: [refund] };
    });
    h.provider.createRefund.mockImplementation(async () => {
      order.push('provider');
      return providerRefund('PENDING');
    });
    h.repo.complete.mockImplementation(async () => {
      order.push('tx2');
      return { applied: true };
    });
    expect(await h.dispatcher.dispatch()).toMatchObject({ locked: true, leased: 1, submitted: 1 });
    expect(order).toEqual(['lease', 'provider', 'tx2']);
    expect(h.repo.lease).toHaveBeenCalledWith({ batchSize: 25, staleLeaseSeconds: 120 });
    expect(h.provider.createRefund).toHaveBeenCalledWith(
      {
        paymentIntentId: 'pi_unit',
        amountMinor: 1999,
        refundId: refund.id,
        metadata: { orderId: refund.orderId },
      },
      { idempotencyKey: `refund:${refund.id}:3` },
    );
    expect(h.repo.complete).toHaveBeenCalledWith(trx, {
      refundId: refund.id,
      orderId: refund.orderId,
      attempt: 3,
      claimedAt: refund.claimedAt,
      status: 'SUBMITTED',
      providerRefundId: 're_unit',
    });
    expect(h.lifecycle.succeeded).not.toHaveBeenCalled();
  });

  it('synchronous success -> SUCCEEDED + RefundSucceeded; a lost fence is a no-op', async () => {
    const h = harness();
    h.provider.createRefund.mockResolvedValue(providerRefund('SUCCEEDED'));
    expect(await h.dispatcher.dispatch()).toMatchObject({ succeeded: 1 });
    expect(h.lifecycle.succeeded).toHaveBeenCalledTimes(1);

    const lost = harness();
    lost.provider.createRefund.mockResolvedValue(providerRefund('SUCCEEDED'));
    lost.repo.complete.mockResolvedValue({ applied: false });
    expect(await lost.dispatcher.dispatch()).toMatchObject({ lost: 1, succeeded: 0 });
    expect(lost.lifecycle.succeeded).not.toHaveBeenCalled();
  });

  it('a refusal (4xx) or a failed answer -> FAILED + RefundFailed with a sanitized code', async () => {
    const h = harness();
    h.provider.createRefund.mockRejectedValue(
      new PaymentInvalidRequestError('nope', {
        operation: 'createRefund',
        providerCode: 'charge_already_refunded',
      }),
    );
    expect(await h.dispatcher.dispatch()).toMatchObject({ failed: 1 });
    expect(h.repo.fail).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ failureCode: 'charge_already_refunded' }),
    );
    expect(h.lifecycle.failed).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ failureCode: 'charge_already_refunded', attempt: 1 }),
    );

    const failed = harness();
    failed.provider.createRefund.mockResolvedValue(providerRefund('FAILED'));
    expect(await failed.dispatcher.dispatch()).toMatchObject({ failed: 1 });
    expect(failed.repo.fail).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ failureCode: 'lost_or_stolen_card' }),
    );
  });

  it('an outage or an unexpected error releases the lease (retried next run); a missing payment intent fails', async () => {
    for (const error of [
      new PaymentProviderUnavailableError({ operation: 'createRefund' }),
      new Error('boom'),
    ]) {
      const h = harness();
      h.provider.createRefund.mockRejectedValue(error);
      expect(await h.dispatcher.dispatch()).toMatchObject({ released: 1, failed: 0 });
      expect(h.repo.release).toHaveBeenCalledTimes(1);
      expect(h.repo.fail).not.toHaveBeenCalled();
    }
    const none = harness({ refunds: [leased({ paymentIntentId: null })] });
    expect(await none.dispatcher.dispatch()).toMatchObject({ failed: 1 });
    expect(none.provider.createRefund).not.toHaveBeenCalled();
  });

  it('another replica holds the lock: nothing is sent', async () => {
    const h = harness({ locked: false, refunds: [] });
    expect(await h.dispatcher.dispatch()).toMatchObject({ locked: false, leased: 0 });
    expect(h.provider.createRefund).not.toHaveBeenCalled();
  });

  it('the kick dispatches exactly the given ids after commit, only with jobs enabled', async () => {
    const off = harness({ jobsEnabled: false });
    new RefundDispatchKick(off.dispatcher).kick(['a']);
    await off.dispatcher.whenIdle();
    expect(off.repo.lease).not.toHaveBeenCalled();

    const on = harness({ jobsEnabled: true });
    new RefundDispatchKick(on.dispatcher).kick(['a', 'b', 'a']);
    on.dispatcher.kick([]);
    await on.dispatcher.whenIdle();
    expect(on.repo.lease).toHaveBeenCalledTimes(1);
    expect(on.repo.lease).toHaveBeenCalledWith({
      batchSize: 25,
      staleLeaseSeconds: 120,
      refundIds: ['a', 'b'],
    });
  });

  it('a kick that finds the lock held retries, then leaves the rest to the poll', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ jobsEnabled: true, locked: false, refunds: [] });
      h.dispatcher.kick(['a']);
      await vi.runAllTimersAsync();
      await h.dispatcher.whenIdle();
      expect(h.repo.lease).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('orderTransitionId', () => {
  it('is a stable, valid UUIDv8 per (order, seq)', () => {
    const order = randomUUID();
    const id = orderTransitionId(order, 1);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(orderTransitionId(order, 1)).toBe(id);
    expect(orderTransitionId(order, 2)).not.toBe(id);
  });
});
