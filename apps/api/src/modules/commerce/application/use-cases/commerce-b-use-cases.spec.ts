import { type CartQuote, ErrorCode } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  type ProviderEvent,
} from '@udemy/payments';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckoutEmailNotVerified,
  CheckoutInProgress,
  CouponNotApplicable,
  PaymentProviderUnavailable,
  PriceChanged,
} from '../../domain/commerce.errors';
import { CheckoutSessionRejected } from '../checkout-sessions.service';
import { CommerceSettings } from '../commerce-settings';
import { CheckoutCommand } from './checkout.command';
import { HandleProviderEventCommand } from './handle-provider-event.command';

/*
 * Use-case orchestration with fakes: what runs inside / outside the transaction, the
 * checkout-specific constraint mapping, and the webhook routing. The SQL, triggers and the
 * real provider are covered by checkout.integration.spec.ts and commerce-b.e2e.spec.ts.
 */
const trx = { isTransaction: true } as unknown as Transaction<DB>;
const ORDER = '01a1244b-642c-78d7-857a-31689e50a790';

/* ------------------------------------------------------------------ CheckoutCommand */

function checkoutHarness(overrides: { verified?: boolean } = {}) {
  const calls: string[] = [];
  const tx = { run: vi.fn() };
  const orders = {
    findPendingCheckout: vi.fn(),
    findCheckoutSnapshot: vi.fn(async () => ({
      orderId: ORDER,
      userId: 'u',
      status: 'PENDING_PAYMENT',
      currency: 'USD',
      totalAmount: '19.99',
      paymentStatus: 'CREATING',
      sessionExpiresAt: new Date(Date.now() + 35 * 60_000),
      checkoutSessionId: null,
      checkoutUrl: null,
      lines: [{ courseTitle: 'T', finalAmount: '19.99' }],
    })),
    openPayment: vi.fn(),
  };
  const sessions = { create: vi.fn() };
  const limiter = {
    hitCheckout: vi.fn(async () => {
      calls.push('rate-limit');
    }),
  };
  const buyers = {
    findBuyer: vi.fn(async () => {
      calls.push('buyer');
      return {
        email: 'b@example.test',
        displayName: 'B',
        emailVerified: overrides.verified ?? true,
      };
    }),
  };
  const command = new CheckoutCommand(
    tx as never,
    {} as never,
    {} as never,
    orders as never,
    {} as never,
    {} as never,
    sessions as never,
    { abandon: vi.fn() } as never,
    {} as never,
    buyers as never,
    limiter as never,
    {} as never,
    CommerceSettings.defaults(),
  );
  const input = {
    userId: 'u',
    idempotencyKey: '7c2f4a2e-3b7e-4c51-9a6a-0f2a5a1d9b10',
    expectedTotal: '19.99',
  };
  return { command, input, tx, orders, sessions, calls };
}

const pgError = (constraint: string) =>
  Object.assign(new Error(constraint), { code: '23505', constraint });

describe('CheckoutCommand', () => {
  it('rate-limits first, then requires a verified email, before any transaction', async () => {
    const h = checkoutHarness({ verified: false });
    await expect(h.command.execute(h.input)).rejects.toBeInstanceOf(CheckoutEmailNotVerified);
    expect(h.calls).toEqual(['rate-limit', 'buyer']);
    expect(h.tx.run).not.toHaveBeenCalled();
  });

  it('a provider outage or refusal after tx A is 503 payment_provider_unavailable (the order stays CREATING)', async () => {
    for (const failure of [
      new PaymentProviderUnavailableError({ operation: 'createCheckoutSession' }),
      new PaymentInvalidRequestError('bad', { operation: 'createCheckoutSession' }),
      new CheckoutSessionRejected('cs_test_1', 'url outside the allow-list'),
    ]) {
      const h = checkoutHarness();
      h.tx.run.mockResolvedValueOnce({ kind: 'create', orderId: ORDER });
      h.sessions.create.mockRejectedValueOnce(failure);
      await expect(h.command.execute(h.input)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
      expect(h.orders.openPayment).not.toHaveBeenCalled();
      expect(h.tx.run).toHaveBeenCalledTimes(1); // tx B never ran
    }
  });

  it('tx B stores the session and answers its url', async () => {
    const h = checkoutHarness();
    h.tx.run
      .mockResolvedValueOnce({ kind: 'create', orderId: ORDER })
      .mockImplementationOnce(async (work: (t: Transaction<DB>) => Promise<unknown>) => work(trx));
    h.sessions.create.mockResolvedValueOnce({
      sessionId: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expiresAt: new Date(),
    });
    h.orders.openPayment.mockResolvedValueOnce(true);
    await expect(h.command.execute(h.input)).resolves.toEqual({
      orderId: ORDER,
      status: 'PENDING_PAYMENT',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(h.orders.openPayment).toHaveBeenCalledWith(trx, ORDER, {
      sessionId: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
  });

  it('maps the races: key unique -> retry (resume), pending unique -> checkout_in_progress, coupon limit -> price_changed + fresh quote', async () => {
    const resumed = checkoutHarness();
    resumed.tx.run
      .mockRejectedValueOnce(pgError('orders_user_id_idempotency_key_uq'))
      .mockResolvedValueOnce({
        kind: 'answer',
        result: { orderId: ORDER, status: 'PAID', checkoutUrl: null },
      });
    await expect(resumed.command.execute(resumed.input)).resolves.toEqual({
      orderId: ORDER,
      status: 'PAID',
      checkoutUrl: null,
    });

    const busy = checkoutHarness();
    busy.tx.run.mockRejectedValueOnce(pgError('orders_user_id_pending_uq'));
    busy.orders.findPendingCheckout.mockResolvedValueOnce({ orderId: ORDER, checkoutUrl: null });
    const inProgress = await busy.command.execute(busy.input).catch((e: unknown) => e);
    expect(inProgress).toBeInstanceOf(CheckoutInProgress);
    expect(inProgress).toMatchObject({ orderId: ORDER, checkoutUrl: null });

    const raced = checkoutHarness();
    const quote = { totals: { totalAmount: '39.99' } } as unknown as CartQuote;
    raced.tx.run
      .mockRejectedValueOnce(
        new CouponNotApplicable(ErrorCode.CouponExhausted, {
          cause: pgError('coupon_redemptions_limit_ck'),
        }),
      )
      .mockResolvedValueOnce({ view: quote });
    const changed = await raced.command.execute(raced.input).catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(PriceChanged);
    expect((changed as PriceChanged).quote).toBe(quote);
  });
});

/* ------------------------------------------------------------------ HandleProviderEventCommand */

function event(data: ProviderEvent['data'], overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: 'evt_1',
    providerType: data.type === 'unhandled' ? 'customer.created' : data.type,
    createdAt: new Date('2026-10-10T12:00:00.000Z'),
    livemode: false,
    apiVersion: null,
    data,
    ...overrides,
  };
}

const completed = (paymentStatus: 'paid' | 'unpaid' = 'paid'): ProviderEvent['data'] => ({
  type: 'checkout.session.completed',
  sessionId: 'cs_test_1',
  orderId: ORDER,
  clientReferenceId: ORDER,
  paymentStatus,
  paymentIntentId: 'pi_1',
  amountTotalMinor: 1999,
  currency: 'USD',
});

function webhookHarness(claimed = true) {
  const inbox = { claim: vi.fn(async () => claimed), finish: vi.fn() };
  const orders = {
    findOwner: vi.fn(async () => 'u'),
    findOrderIdBySession: vi.fn(async () => null),
    findOrderIdByPaymentIntent: vi.fn(async () => null),
    markPaid: vi.fn(async () => ({
      outcome: 'APPLIED',
      userId: 'u',
      previousStatus: 'PENDING_PAYMENT',
      paidAt: new Date(),
      lines: [{ id: 'l1', courseId: 'c1', finalAmount: '19.99' }],
    })),
    findHeader: vi.fn(),
    lockOrder: vi.fn(),
  };
  const lifecycle = {
    settlePaid: vi.fn(async () => ({ duplicateRefundIds: ['refund-1'] })),
    close: vi.fn(),
  };
  const refundEvents = { apply: vi.fn(async () => ({ outcome: 'IGNORED', orderId: null })) };
  const dispatch = { kick: vi.fn() };
  const command = new HandleProviderEventCommand(
    { run: (work: (t: Transaction<DB>) => Promise<unknown>) => work(trx) } as never,
    inbox as never,
    orders as never,
    { lockCart: vi.fn() } as never,
    lifecycle as never,
    {} as never,
    { now: vi.fn(async () => new Date()) } as never,
    refundEvents as never,
    dispatch as never,
  );
  return { command, inbox, orders, lifecycle, refundEvents, dispatch };
}

const sha = Buffer.alloc(32);

describe('HandleProviderEventCommand', () => {
  it('a duplicate claim does nothing else (DUPLICATE)', async () => {
    const h = webhookHarness(false);
    await expect(h.command.execute(event(completed()), sha)).resolves.toEqual({
      outcome: 'DUPLICATE',
      orderId: null,
    });
    expect(h.orders.markPaid).not.toHaveBeenCalled();
    expect(h.inbox.finish).not.toHaveBeenCalled();
  });

  it('completed + paid: PAID through markPaid (cause by source), settle, outcome APPLIED; kicks the dispatcher after commit', async () => {
    const h = webhookHarness();
    await expect(h.command.execute(event(completed()), sha, 'RECONCILER')).resolves.toEqual({
      outcome: 'APPLIED',
      orderId: ORDER,
    });
    expect(h.orders.markPaid).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({
        cause: 'RECONCILER',
        receivedAmount: '19.99',
        receivedCurrency: 'USD',
        paymentIntentId: 'pi_1',
      }),
    );
    expect(h.lifecycle.settlePaid).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ provider: 'STRIPE', orderId: ORDER }),
    );
    expect(h.inbox.finish).toHaveBeenCalledWith(trx, 'evt_1', 'APPLIED', ORDER);
    expect(h.dispatch.kick).toHaveBeenCalledTimes(1);
    expect(h.dispatch.kick).toHaveBeenCalledWith(['refund-1']);
  });

  it('unpaid sessions, livemode and async_payment events are recorded as IGNORED', async () => {
    const unpaid = webhookHarness();
    await expect(unpaid.command.execute(event(completed('unpaid')), sha)).resolves.toEqual({
      outcome: 'IGNORED',
      orderId: ORDER,
    });
    expect(unpaid.orders.markPaid).not.toHaveBeenCalled();

    const live = webhookHarness();
    await expect(
      live.command.execute(event(completed(), { livemode: true }), sha),
    ).resolves.toEqual({ outcome: 'IGNORED', orderId: null });
    expect(live.inbox.claim).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ livemode: true, objectId: 'cs_test_1' }),
    );
    expect(live.orders.markPaid).not.toHaveBeenCalled();

    const asyncEvent = webhookHarness();
    await expect(
      asyncEvent.command.execute(
        event({ type: 'unhandled' }, { providerType: 'checkout.session.async_payment_succeeded' }),
        sha,
      ),
    ).resolves.toEqual({ outcome: 'IGNORED', orderId: null });
    expect(asyncEvent.inbox.finish).toHaveBeenCalledWith(trx, 'evt_1', 'IGNORED', null);
  });

  it('an unknown order is ORPHAN; refund events go to the P4-T16 seam', async () => {
    const orphan = webhookHarness();
    orphan.orders.findOwner.mockResolvedValue(null as never);
    await expect(orphan.command.execute(event(completed()), sha)).resolves.toEqual({
      outcome: 'ORPHAN',
      orderId: null,
    });

    const refund = webhookHarness();
    const data: ProviderEvent['data'] = {
      type: 'refund.updated',
      providerRefundId: 're_1',
      refundId: null,
      paymentIntentId: 'pi_1',
      status: 'SUCCEEDED',
      providerStatus: 'succeeded',
      amountMinor: 1999,
      currency: 'USD',
      failureReason: null,
    };
    await expect(refund.command.execute(event(data), sha)).resolves.toEqual({
      outcome: 'IGNORED',
      orderId: null,
    });
    expect(refund.refundEvents.apply).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ id: 'evt_1' }),
      data,
    );
    expect(refund.inbox.claim).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ objectId: 're_1' }),
    );
  });
});
