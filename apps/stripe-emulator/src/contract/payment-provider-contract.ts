import { randomUUID } from 'node:crypto';
import type {
  CreateCheckoutSessionInput,
  CreateRefundInput,
  PaymentProvider,
} from '@udemy/payments';
import {
  buildCheckoutSessionParams,
  buildRefundParams,
  checkoutSessionIdempotencyKey,
  createStripeClient,
  PaymentAuthenticationError,
  PaymentIdempotencyError,
  PaymentInvalidRequestError,
  PaymentResourceNotFoundError,
  refundIdempotencyKey,
  StripePaymentProvider,
  toPaymentError,
} from '@udemy/payments';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

/**
 * The shared PaymentProvider contract (design D12): the REAL `StripePaymentProvider` from
 * `@udemy/payments`, over HTTP, against a Stripe-compatible server. Stateless cases (request
 * shapes accepted / rejected) run against every target, stateful ones (state, idempotency,
 * expire classification, refund lifecycle) only where the target keeps state: the emulator yes,
 * stripe-mock no (its responses are fixtures).
 */
export interface ContractTarget {
  readonly name: string;
  readonly stateful: boolean;
  readonly secretKey: string;
  /** Resolved lazily (the target is started in beforeAll). */
  baseUrl(): string;
  /** Skips the test when the target is unavailable (optional targets). */
  skipIfUnavailable?(ctx: { skip(condition: boolean, note?: string): void }): void;
  /** A payment intent that can be refunded `amountMinor` (stateful targets: really paid). */
  paidPaymentIntent(amountMinor: number): Promise<string>;
  /** Pays an open session (stateful targets only). */
  completeSession?(sessionId: string): Promise<void>;
  /** The next refund is created pending and then fails (stateful targets only). */
  failNextRefund?(failureReason: string): Promise<void>;
}

export function checkoutInput(
  overrides: Partial<CreateCheckoutSessionInput> = {},
): CreateCheckoutSessionInput {
  const orderId = randomUUID();
  return {
    orderId,
    currency: 'USD',
    lines: [
      { name: 'TypeScript in depth', unitAmountMinor: 1999 },
      { name: 'Free with coupon', unitAmountMinor: 0 },
      { name: 'NestJS microservices', unitAmountMinor: 19999 },
    ],
    customerEmail: 'buyer@example.test',
    successUrl: `http://127.0.0.1:3000/checkout/success?orderId=${orderId}&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: 'http://127.0.0.1:3000/cart',
    expiresAt: new Date(Date.now() + 30 * 60_000 + 60_000),
    metadata: { userId: randomUUID() },
    ...overrides,
  };
}

function refundInput(paymentIntentId: string, amountMinor: number): CreateRefundInput {
  return {
    paymentIntentId,
    amountMinor,
    refundId: randomUUID(),
    reason: 'requested_by_customer',
    metadata: { orderId: randomUUID() },
  };
}

async function rejection(promise: Promise<unknown>, operation = 'test'): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return toPaymentError(error, operation);
  }
  throw new Error('expected the request to be rejected');
}

export function definePaymentProviderContract(target: ContractTarget): void {
  function provider(secretKey = target.secretKey): PaymentProvider {
    return new StripePaymentProvider({
      secretKey,
      apiBaseUrl: target.baseUrl(),
      maxNetworkRetries: 0,
    });
  }

  function client(): Stripe {
    return createStripeClient({
      secretKey: target.secretKey,
      apiBaseUrl: target.baseUrl(),
      maxNetworkRetries: 0,
    });
  }

  function skip(ctx: { skip(condition: boolean, note?: string): void }): void {
    target.skipIfUnavailable?.(ctx);
  }

  const stateful = it.skipIf(!target.stateful);

  describe(`PaymentProvider contract: ${target.name}`, () => {
    describe('checkout sessions (request shapes)', () => {
      it('accepts the exact create parameters and returns a hosted URL', async (ctx) => {
        skip(ctx);
        const created = await provider().createCheckoutSession(checkoutInput(), {
          idempotencyKey: randomUUID(),
        });
        expect(created.sessionId).toMatch(/^cs_/);
        expect(() => new URL(created.url)).not.toThrow();
        expect(created.expiresAt).toBeInstanceOf(Date);
      });

      it('rejects payment_method_types (removed at 2026-09-30.endive)', async (ctx) => {
        skip(ctx);
        const params = {
          ...buildCheckoutSessionParams(checkoutInput()),
          payment_method_types: ['card'],
        } as unknown as Stripe.Checkout.SessionCreateParams;
        const error = await rejection(client().checkout.sessions.create(params));
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        // stripe-mock's validation errors carry no `param`; the emulator mirrors Stripe's.
        if (target.stateful) {
          expect((error as PaymentInvalidRequestError).param).toBe('payment_method_types');
        }
      });

      it('rejects an unknown parameter with a Stripe-like 400', async (ctx) => {
        skip(ctx);
        const params = {
          ...buildCheckoutSessionParams(checkoutInput()),
          not_a_stripe_param: 'x',
        } as unknown as Stripe.Checkout.SessionCreateParams;
        const error = await rejection(client().checkout.sessions.create(params));
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect((error as PaymentInvalidRequestError).httpStatus).toBe(400);
        if (target.stateful) {
          expect((error as PaymentInvalidRequestError).param).toBe('not_a_stripe_param');
        }
      });

      it('rejects a malformed line item (string unit_amount)', async (ctx) => {
        skip(ctx);
        const params = {
          ...buildCheckoutSessionParams(checkoutInput()),
          line_items: [
            {
              quantity: 1,
              price_data: { currency: 'usd', unit_amount: 'abc', product_data: { name: 'x' } },
            },
          ],
        } as unknown as Stripe.Checkout.SessionCreateParams;
        const error = await rejection(client().checkout.sessions.create(params));
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      });

      it('retrieves a session as a ProviderCheckoutSession', async (ctx) => {
        skip(ctx);
        const p = provider();
        const created = await p.createCheckoutSession(checkoutInput(), {
          idempotencyKey: randomUUID(),
        });
        const session = await p.retrieveCheckoutSession(created.sessionId);
        expect(['open', 'complete', 'expired']).toContain(session.status);
        expect(session.livemode).toBe(false);
        expect(session.expiresAt).toBeInstanceOf(Date);
      });
    });

    describe('checkout sessions (state)', () => {
      stateful('retrieve reflects exactly what create was given', async () => {
        const p = provider();
        const input = checkoutInput();
        const created = await p.createCheckoutSession(input, { idempotencyKey: randomUUID() });
        const session = await p.retrieveCheckoutSession(created.sessionId);
        expect(session).toEqual({
          sessionId: created.sessionId,
          status: 'open',
          paymentStatus: 'unpaid',
          orderId: input.orderId,
          clientReferenceId: input.orderId,
          paymentIntentId: null,
          amountTotalMinor: 1999 + 0 + 19999,
          currency: 'USD',
          url: created.url,
          expiresAt: new Date(Math.floor(input.expiresAt.getTime() / 1000) * 1000),
          livemode: false,
        });
        expect(created.expiresAt).toEqual(session.expiresAt);
      });

      stateful('replays the original session for the same key and parameters', async () => {
        const p = provider();
        const input = checkoutInput();
        const key = checkoutSessionIdempotencyKey(input.orderId);
        const first = await p.createCheckoutSession(input, { idempotencyKey: key });
        const second = await p.createCheckoutSession(input, { idempotencyKey: key });
        expect(second).toEqual(first);
      });

      stateful('rejects the same key with different parameters (idempotency_error)', async () => {
        const p = provider();
        const input = checkoutInput();
        const key = checkoutSessionIdempotencyKey(input.orderId);
        await p.createCheckoutSession(input, { idempotencyKey: key });
        const error = await rejection(
          p.createCheckoutSession(
            { ...input, lines: [{ name: 'Another course', unitAmountMinor: 2999 }] },
            { idempotencyKey: key },
          ),
        );
        expect(error).toBeInstanceOf(PaymentIdempotencyError);
        expect((error as PaymentIdempotencyError).httpStatus).toBe(400);
      });

      stateful('expires an open session; a second expire reports ALREADY_EXPIRED', async () => {
        const p = provider();
        const { sessionId } = await p.createCheckoutSession(checkoutInput(), {
          idempotencyKey: randomUUID(),
        });
        await expect(p.expireCheckoutSession(sessionId)).resolves.toBe('EXPIRED');
        const session = await p.retrieveCheckoutSession(sessionId);
        expect(session.status).toBe('expired');
        expect(session.url).toBeNull();
        await expect(p.expireCheckoutSession(sessionId)).resolves.toBe('ALREADY_EXPIRED');
      });

      stateful('reports ALREADY_COMPLETE when the buyer has paid', async () => {
        const p = provider();
        const { sessionId } = await p.createCheckoutSession(checkoutInput(), {
          idempotencyKey: randomUUID(),
        });
        await target.completeSession?.(sessionId);
        await expect(p.expireCheckoutSession(sessionId)).resolves.toBe('ALREADY_COMPLETE');
        const session = await p.retrieveCheckoutSession(sessionId);
        expect(session).toMatchObject({ status: 'complete', paymentStatus: 'paid' });
        expect(session.paymentIntentId).toMatch(/^pi_/);
      });

      stateful('an unknown session is PaymentResourceNotFoundError', async () => {
        const error = await rejection(provider().retrieveCheckoutSession('cs_test_doesnotexist'));
        expect(error).toBeInstanceOf(PaymentResourceNotFoundError);
      });

      stateful('a wrong API key is PaymentAuthenticationError', async () => {
        const error = await rejection(
          provider('sk_test_wrongkey').retrieveCheckoutSession('cs_test_any'),
        );
        expect(error).toBeInstanceOf(PaymentAuthenticationError);
      });
    });

    describe('refunds', () => {
      it('accepts the exact refund parameters', async (ctx) => {
        skip(ctx);
        const paymentIntentId = await target.paidPaymentIntent(1999);
        const refund = await provider().createRefund(refundInput(paymentIntentId, 1999), {
          idempotencyKey: randomUUID(),
        });
        expect(refund.providerRefundId).toMatch(/^re_/);
        expect(['PENDING', 'SUCCEEDED', 'FAILED']).toContain(refund.status);
      });

      it('rejects an unknown refund reason', async (ctx) => {
        skip(ctx);
        const paymentIntentId = await target.paidPaymentIntent(1999);
        const params = {
          ...buildRefundParams(refundInput(paymentIntentId, 1999)),
          reason: 'changed_my_mind',
        } as unknown as Stripe.RefundCreateParams;
        const error = await rejection(client().refunds.create(params));
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      });

      stateful('creates, replays and retrieves a refund', async () => {
        const p = provider();
        const paymentIntentId = await target.paidPaymentIntent(21998);
        const input = refundInput(paymentIntentId, 1999);
        const key = refundIdempotencyKey(input.refundId, 1);
        const refund = await p.createRefund(input, { idempotencyKey: key });
        expect(refund).toEqual({
          providerRefundId: refund.providerRefundId,
          status: 'SUCCEEDED',
          providerStatus: 'succeeded',
          refundId: input.refundId,
          paymentIntentId,
          amountMinor: 1999,
          currency: 'USD',
          failureReason: null,
        });
        await expect(p.createRefund(input, { idempotencyKey: key })).resolves.toEqual(refund);
        await expect(p.retrieveRefund(refund.providerRefundId)).resolves.toEqual(refund);
      });

      stateful('refuses to refund more than what is left on the charge', async () => {
        const p = provider();
        const paymentIntentId = await target.paidPaymentIntent(1999);
        await p.createRefund(refundInput(paymentIntentId, 1999), { idempotencyKey: randomUUID() });
        const error = await rejection(
          p.createRefund(refundInput(paymentIntentId, 1), { idempotencyKey: randomUUID() }),
        );
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect((error as PaymentInvalidRequestError).providerCode).toBe('charge_already_refunded');
      });

      stateful('a planned failure is returned PENDING and then retrieved FAILED', async () => {
        const p = provider();
        const paymentIntentId = await target.paidPaymentIntent(1999);
        await target.failNextRefund?.('lost_or_stolen_card');
        const input = refundInput(paymentIntentId, 1999);
        const created = await p.createRefund(input, { idempotencyKey: randomUUID() });
        expect(created).toMatchObject({ status: 'PENDING', refundId: input.refundId });
        const retrieved = await p.retrieveRefund(created.providerRefundId);
        expect(retrieved).toMatchObject({
          status: 'FAILED',
          providerStatus: 'failed',
          failureReason: 'lost_or_stolen_card',
        });
        // A failed refund releases the amount: a retry (attempt 2) can refund it.
        const retry = await p.createRefund(input, {
          idempotencyKey: refundIdempotencyKey(input.refundId, 2),
        });
        expect(retry.status).toBe('SUCCEEDED');
      });

      stateful('unknown payment intents and refunds are PaymentResourceNotFoundError', async () => {
        const p = provider();
        const missingIntent = await rejection(
          p.createRefund(refundInput('pi_doesnotexist', 100), { idempotencyKey: randomUUID() }),
        );
        expect(missingIntent).toBeInstanceOf(PaymentResourceNotFoundError);
        const missingRefund = await rejection(p.retrieveRefund('re_doesnotexist'));
        expect(missingRefund).toBeInstanceOf(PaymentResourceNotFoundError);
      });
    });
  });
}
