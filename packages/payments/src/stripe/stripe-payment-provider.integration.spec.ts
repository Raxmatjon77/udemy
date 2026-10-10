import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentInvalidRequestError } from '../errors';
import type { CreateCheckoutSessionInput, CreateRefundInput } from '../payment-provider';
import { checkoutSessionIdempotencyKey, refundIdempotencyKey } from '../payment-provider';
import {
  STRIPE_MOCK_API_KEY,
  STRIPE_MOCK_VERSION,
  useStripeMock,
} from '../testing/it-stripe-mock.mjs';
import { createStripeClient } from './stripe-config';
import { toPaymentError } from './stripe-errors';
import {
  buildCheckoutSessionParams,
  buildRefundParams,
  StripePaymentProvider,
} from './stripe-payment-provider';

/**
 * Contract tests (design D12 layer 1, §12 risk T4): stripe-mock validates every request against
 * Stripe's OpenAPI spec and rejects unknown parameters, so a 200 here proves our EXACT parameters
 * are accepted for the pinned API version. The negative controls prove it is really validating.
 * stripe-mock is stateless: responses are fixtures, so we assert acceptance, not state.
 */
const mock = useStripeMock();

function provider(): StripePaymentProvider {
  return new StripePaymentProvider({
    secretKey: STRIPE_MOCK_API_KEY,
    apiBaseUrl: mock.baseUrl,
    maxNetworkRetries: 0,
  });
}

function client(): Stripe {
  return createStripeClient({
    secretKey: STRIPE_MOCK_API_KEY,
    apiBaseUrl: mock.baseUrl,
    maxNetworkRetries: 0,
  });
}

const checkoutInput: CreateCheckoutSessionInput = {
  orderId: '0192f3a4-5b6c-7d8e-9f00-112233445566',
  currency: 'USD',
  lines: [
    { name: 'TypeScript in depth', unitAmountMinor: 1999 },
    { name: 'Free with coupon', unitAmountMinor: 0 },
    { name: 'NestJS microservices', unitAmountMinor: 19999 },
  ],
  customerEmail: 'buyer@example.test',
  successUrl: 'http://127.0.0.1:3000/checkout/success?orderId=0192f3a4',
  cancelUrl: 'http://127.0.0.1:3000/cart',
  expiresAt: new Date(Date.now() + 30 * 60_000 + 60_000),
  metadata: { userId: '0192f3a4-0000-7000-8000-000000000001' },
};

const refundInput: CreateRefundInput = {
  paymentIntentId: 'pi_3PgafyB7WZ01zgkW0000test',
  amountMinor: 1999,
  refundId: '0192f3a4-0000-7000-8000-0000000000aa',
  reason: 'requested_by_customer',
  metadata: { orderId: checkoutInput.orderId },
};

async function rejection(promise: Promise<unknown>, operation: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return toPaymentError(error, operation);
  }
  throw new Error('expected stripe-mock to reject the request');
}

describe('stripe-mock contract', () => {
  it(`runs against stripe-mock ${STRIPE_MOCK_VERSION}`, (ctx) => {
    mock.skipIfUnavailable(ctx);
    expect(mock.version).toBe(STRIPE_MOCK_VERSION);
  });

  describe('Checkout Session create', () => {
    it('accepts our exact params: expires_at, inline price_data, client_reference_id, metadata, payment_intent_data.metadata, allowed_payment_method_types, customer_email', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const params = buildCheckoutSessionParams(checkoutInput);
      // Guard the shape under test so this file fails loudly if the builder drifts.
      expect(Object.keys(params).sort()).toEqual(
        [
          'allowed_payment_method_types',
          'cancel_url',
          'client_reference_id',
          'customer_email',
          'expires_at',
          'line_items',
          'metadata',
          'mode',
          'payment_intent_data',
          'success_url',
        ].sort(),
      );
      const created = await provider().createCheckoutSession(checkoutInput, {
        idempotencyKey: checkoutSessionIdempotencyKey(checkoutInput.orderId),
      });
      expect(created.sessionId).toMatch(/^cs_/);
      expect(created.url).toMatch(/^https:\/\//);
      expect(created.expiresAt).toBeInstanceOf(Date);
    });

    it('accepts the minimal variant (no customer_email, no extra metadata, one line)', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const withoutMetadata: CreateCheckoutSessionInput = { ...checkoutInput };
      delete (withoutMetadata as { metadata?: unknown }).metadata;
      await expect(
        provider().createCheckoutSession(
          {
            ...withoutMetadata,
            customerEmail: null,
            lines: [{ name: 'One course', unitAmountMinor: 1999 }],
          },
          { idempotencyKey: checkoutSessionIdempotencyKey('min') },
        ),
      ).resolves.toMatchObject({ sessionId: expect.stringMatching(/^cs_/) as unknown });
    });

    it('negative control: an unknown parameter is rejected', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const params = {
        ...buildCheckoutSessionParams(checkoutInput),
        not_a_stripe_param: 'x',
      } as unknown as Stripe.Checkout.SessionCreateParams;
      const error = await rejection(client().checkout.sessions.create(params), 'create');
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    });

    it('design impact: payment_method_types is REJECTED for the pinned API version', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const rest: Partial<Stripe.Checkout.SessionCreateParams> =
        buildCheckoutSessionParams(checkoutInput);
      delete rest.allowed_payment_method_types;
      const params = {
        ...rest,
        payment_method_types: ['card'],
      } as unknown as Stripe.Checkout.SessionCreateParams;
      const error = await rejection(client().checkout.sessions.create(params), 'create');
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    });

    it('negative control: a malformed line item (string unit_amount) is rejected', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const base = buildCheckoutSessionParams(checkoutInput);
      const params = {
        ...base,
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: 'abc', product_data: { name: 'x' } },
          },
        ],
      } as unknown as Stripe.Checkout.SessionCreateParams;
      const error = await rejection(client().checkout.sessions.create(params), 'create');
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    });
  });

  describe('Checkout Session retrieve and expire', () => {
    it('retrieve is accepted and maps', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const session = await provider().retrieveCheckoutSession('cs_test_contract');
      expect(session.sessionId).toMatch(/^cs_/);
      expect(['open', 'complete', 'expired']).toContain(session.status);
    });

    it('expire is accepted', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      expect(await provider().expireCheckoutSession('cs_test_contract')).toBe('EXPIRED');
    });
  });

  describe('Refunds', () => {
    it('accepts our exact refund params: payment_intent, amount, metadata.refundId, reason', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      expect(Object.keys(buildRefundParams(refundInput)).sort()).toEqual(
        ['amount', 'metadata', 'payment_intent', 'reason'].sort(),
      );
      const refund = await provider().createRefund(refundInput, {
        idempotencyKey: refundIdempotencyKey(refundInput.refundId, 1),
      });
      expect(refund.providerRefundId).toMatch(/^re_/);
      expect(['PENDING', 'SUCCEEDED', 'FAILED']).toContain(refund.status);
    });

    it.for(['duplicate', 'fraudulent', 'requested_by_customer'] as const)(
      'accepts reason=%s',
      async (reason, ctx) => {
        mock.skipIfUnavailable(ctx);
        await expect(
          provider().createRefund(
            { ...refundInput, reason },
            { idempotencyKey: refundIdempotencyKey(refundInput.refundId, 2) },
          ),
        ).resolves.toMatchObject({ providerRefundId: expect.stringMatching(/^re_/) as unknown });
      },
    );

    it('negative control: an unknown refund reason is rejected', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const params = {
        ...buildRefundParams(refundInput),
        reason: 'changed_my_mind',
      } as unknown as Stripe.RefundCreateParams;
      const error = await rejection(client().refunds.create(params), 'createRefund');
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    });

    it('retrieve refund is accepted', async (ctx) => {
      mock.skipIfUnavailable(ctx);
      const refund = await provider().retrieveRefund('re_contract');
      expect(refund.providerRefundId).toMatch(/^re_/);
    });
  });
});
