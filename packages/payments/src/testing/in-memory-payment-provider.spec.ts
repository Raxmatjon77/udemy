import { describe, expect, it } from 'vitest';
import {
  PaymentIdempotencyError,
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  PaymentResourceNotFoundError,
  PaymentUsageError,
  WebhookSignatureInvalidError,
} from '../errors';
import type { CreateCheckoutSessionInput, PaymentProvider } from '../payment-provider';
import { checkoutSessionIdempotencyKey, refundIdempotencyKey } from '../payment-provider';
import { InMemoryPaymentProvider, randomWebhookSecret, signedWebhookRequest } from './index.mjs';

const input: CreateCheckoutSessionInput = {
  orderId: 'ord_1',
  currency: 'USD',
  lines: [
    { name: 'A', unitAmountMinor: 1999 },
    { name: 'B', unitAmountMinor: 2499 },
  ],
  customerEmail: null,
  successUrl: 'http://127.0.0.1:3000/s',
  cancelUrl: 'http://127.0.0.1:3000/c',
  expiresAt: new Date('2026-10-10T12:30:00.000Z'),
};
const key = { idempotencyKey: checkoutSessionIdempotencyKey('ord_1') };

describe('InMemoryPaymentProvider', () => {
  it('implements the port', () => {
    const provider: PaymentProvider = new InMemoryPaymentProvider();
    expect(typeof provider.verifyWebhook).toBe('function');
  });

  it('createCheckoutSession is idempotent per key and rejects a key reused with other params', async () => {
    const provider = new InMemoryPaymentProvider();
    const first = await provider.createCheckoutSession(input, key);
    const replay = await provider.createCheckoutSession(input, key);
    expect(replay).toEqual(first);
    expect(first.url).toBe(`https://checkout.test/pay/${first.sessionId}`);
    await expect(
      provider.createCheckoutSession({ ...input, orderId: 'ord_2' }, key),
    ).rejects.toBeInstanceOf(PaymentIdempotencyError);
    expect(provider.calls.map((call) => call.idempotencyKey)).toEqual([
      'checkout-session:ord_1',
      'checkout-session:ord_1',
      'checkout-session:ord_1',
    ]);
  });

  it('applies the adapter validation (same usage errors)', async () => {
    const provider = new InMemoryPaymentProvider();
    await expect(
      provider.createCheckoutSession({ ...input, lines: [] }, key),
    ).rejects.toBeInstanceOf(PaymentUsageError);
  });

  it('failNext injects one failure (default: provider unavailable), then recovers', async () => {
    const provider = new InMemoryPaymentProvider();
    provider.failNext('createCheckoutSession');
    await expect(provider.createCheckoutSession(input, key)).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    await expect(provider.createCheckoutSession(input, key)).resolves.toMatchObject({
      sessionId: expect.stringMatching(/^cs_test_/) as unknown,
    });
  });

  it('session lifecycle: complete, expire results, retrieve after expires_at', async () => {
    let now = new Date('2026-10-10T12:00:00.000Z');
    const provider = new InMemoryPaymentProvider({ now: () => now });
    const a = await provider.createCheckoutSession(input, key);
    const completed = provider.completeSession(a.sessionId, { paymentIntentId: 'pi_1' });
    expect(completed).toMatchObject({
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentId: 'pi_1',
    });
    expect(await provider.expireCheckoutSession(a.sessionId)).toBe('ALREADY_COMPLETE');

    const b = await provider.createCheckoutSession(
      { ...input, orderId: 'ord_2' },
      { idempotencyKey: 'checkout-session:ord_2' },
    );
    expect(await provider.expireCheckoutSession(b.sessionId)).toBe('EXPIRED');
    expect(await provider.expireCheckoutSession(b.sessionId)).toBe('ALREADY_EXPIRED');

    const c = await provider.createCheckoutSession(
      { ...input, orderId: 'ord_3' },
      { idempotencyKey: 'checkout-session:ord_3' },
    );
    now = new Date('2026-10-10T12:31:00.000Z');
    expect((await provider.retrieveCheckoutSession(c.sessionId)).status).toBe('expired');
    await expect(provider.retrieveCheckoutSession('cs_missing')).rejects.toBeInstanceOf(
      PaymentResourceNotFoundError,
    );
  });

  it('refunds: idempotent, bounded by the captured amount, status controllable', async () => {
    const provider = new InMemoryPaymentProvider();
    const { sessionId } = await provider.createCheckoutSession(input, key);
    provider.completeSession(sessionId, { paymentIntentId: 'pi_1' });

    const refundInput = { paymentIntentId: 'pi_1', amountMinor: 1999, refundId: 'rf_1' };
    const first = await provider.createRefund(refundInput, {
      idempotencyKey: refundIdempotencyKey('rf_1', 1),
    });
    expect(first).toMatchObject({ status: 'PENDING', refundId: 'rf_1', currency: 'USD' });
    const replay = await provider.createRefund(refundInput, {
      idempotencyKey: refundIdempotencyKey('rf_1', 1),
    });
    expect(replay.providerRefundId).toBe(first.providerRefundId);

    await expect(
      provider.createRefund(
        { paymentIntentId: 'pi_1', amountMinor: 2500, refundId: 'rf_2' },
        { idempotencyKey: refundIdempotencyKey('rf_2', 1) },
      ),
    ).rejects.toBeInstanceOf(PaymentInvalidRequestError);
    await expect(
      provider.createRefund(
        { paymentIntentId: 'pi_unknown', amountMinor: 1, refundId: 'rf_3' },
        { idempotencyKey: refundIdempotencyKey('rf_3', 1) },
      ),
    ).rejects.toBeInstanceOf(PaymentResourceNotFoundError);

    provider.setRefundStatus(first.providerRefundId, 'SUCCEEDED');
    expect((await provider.retrieveRefund(first.providerRefundId)).status).toBe('SUCCEEDED');
  });

  it('verifyWebhook uses real verification on events built from its own state', async () => {
    const provider = new InMemoryPaymentProvider();
    const secret = randomWebhookSecret();
    const { sessionId } = await provider.createCheckoutSession(input, key);
    provider.completeSession(sessionId, { paymentIntentId: 'pi_9' });

    const request = signedWebhookRequest(provider.checkoutCompletedEvent(sessionId), secret);
    const event = provider.verifyWebhook(request.body, request.headers['stripe-signature'], secret);
    expect(event.data).toEqual({
      type: 'checkout.session.completed',
      sessionId,
      orderId: 'ord_1',
      clientReferenceId: 'ord_1',
      paymentStatus: 'paid',
      paymentIntentId: 'pi_9',
      amountTotalMinor: 4498,
      currency: 'USD',
    });
    expect(() =>
      provider.verifyWebhook(
        request.body,
        request.headers['stripe-signature'],
        randomWebhookSecret(),
      ),
    ).toThrow(WebhookSignatureInvalidError);

    provider.refundOutcome = 'FAILED';
    const refund = await provider.createRefund(
      { paymentIntentId: 'pi_9', amountMinor: 1999, refundId: 'rf_9' },
      { idempotencyKey: refundIdempotencyKey('rf_9', 1) },
    );
    const refundRequest = signedWebhookRequest(
      provider.refundEvent(refund.providerRefundId),
      secret,
    );
    expect(
      provider.verifyWebhook(refundRequest.body, refundRequest.headers['stripe-signature'], secret)
        .data,
    ).toMatchObject({ type: 'refund.failed', refundId: 'rf_9', status: 'FAILED' });
  });
});
