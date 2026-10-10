import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DependencyUnavailableError } from '@udemy/nest-common/errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PaymentAuthenticationError,
  PaymentCardError,
  PaymentIdempotencyError,
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  PaymentResourceNotFoundError,
  PaymentUsageError,
} from '../errors';
import type { CreateCheckoutSessionInput } from '../payment-provider';
import { checkoutSessionIdempotencyKey, refundIdempotencyKey } from '../payment-provider';
import { STRIPE_API_VERSION } from './stripe-config';
import { buildCheckoutSessionParams, StripePaymentProvider } from './stripe-payment-provider';

interface Captured {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  form: URLSearchParams;
}

type Reply = { status: number; body: unknown };

let server: Server;
let baseUrl: string;
const captured: Captured[] = [];
let replies: Reply[] = [];

const expiresAt = new Date('2026-10-10T12:30:00.000Z');

function sessionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cs_test_1',
    object: 'checkout.session',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    metadata: { orderId: 'ord_1' },
    client_reference_id: 'ord_1',
    payment_intent: null,
    amount_total: 4498,
    currency: 'usd',
    livemode: false,
    ...overrides,
  };
}

function stripeError(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: { type, message: 'mock error', ...extra } };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
      });
      const reply = replies.shift() ?? { status: 200, body: sessionJson() };
      res.writeHead(reply.status, { 'content-type': 'application/json', 'request-id': 'req_t' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
  replies = [];
});

function provider(): StripePaymentProvider {
  return new StripePaymentProvider({
    secretKey: 'sk_test_unit',
    apiBaseUrl: baseUrl,
    maxNetworkRetries: 0,
    timeoutMs: 5_000,
  });
}

const input: CreateCheckoutSessionInput = {
  orderId: 'ord_1',
  currency: 'USD',
  lines: [
    { name: 'TypeScript in depth', unitAmountMinor: 1999 },
    { name: 'NestJS', unitAmountMinor: 2499 },
  ],
  customerEmail: 'buyer@example.test',
  successUrl: 'http://127.0.0.1:3000/checkout/success?orderId=ord_1',
  cancelUrl: 'http://127.0.0.1:3000/cart',
  expiresAt,
  metadata: { userId: 'usr_1' },
};

describe('StripePaymentProvider: wire format (base-URL override)', () => {
  it('createCheckoutSession sends our exact params, the idempotency key and the pinned version', async () => {
    const created = await provider().createCheckoutSession(input, {
      idempotencyKey: checkoutSessionIdempotencyKey('ord_1'),
    });
    expect(created).toEqual({
      sessionId: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expiresAt,
    });
    const [request] = captured;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/checkout/sessions');
    expect(request?.headers['idempotency-key']).toBe('checkout-session:ord_1');
    expect(request?.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(request?.headers.authorization).toBe('Bearer sk_test_unit');
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      mode: 'payment',
      'allowed_payment_method_types[0]': 'card',
      client_reference_id: 'ord_1',
      'metadata[userId]': 'usr_1',
      'metadata[orderId]': 'ord_1',
      'payment_intent_data[metadata][userId]': 'usr_1',
      'payment_intent_data[metadata][orderId]': 'ord_1',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '1999',
      'line_items[0][price_data][product_data][name]': 'TypeScript in depth',
      'line_items[1][quantity]': '1',
      'line_items[1][price_data][currency]': 'usd',
      'line_items[1][price_data][unit_amount]': '2499',
      'line_items[1][price_data][product_data][name]': 'NestJS',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: String(Math.floor(expiresAt.getTime() / 1000)),
      customer_email: 'buyer@example.test',
    });
  });

  it('metadata.orderId cannot be overridden by extra metadata', () => {
    const params = buildCheckoutSessionParams({ ...input, metadata: { orderId: 'evil' } });
    expect(params.metadata).toEqual({ orderId: 'ord_1' });
    expect(params.payment_intent_data?.metadata).toEqual({ orderId: 'ord_1' });
  });

  it('omits customer_email when null', () => {
    expect(buildCheckoutSessionParams({ ...input, customerEmail: null })).not.toHaveProperty(
      'customer_email',
    );
  });

  it('retrieveCheckoutSession maps the session (currency upper-cased)', async () => {
    replies.push({
      status: 200,
      body: sessionJson({
        status: 'complete',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        url: null,
      }),
    });
    const session = await provider().retrieveCheckoutSession('cs_test_1');
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.path).toBe('/v1/checkout/sessions/cs_test_1');
    expect(session).toEqual({
      sessionId: 'cs_test_1',
      status: 'complete',
      paymentStatus: 'paid',
      orderId: 'ord_1',
      clientReferenceId: 'ord_1',
      paymentIntentId: 'pi_1',
      amountTotalMinor: 4498,
      currency: 'USD',
      url: null,
      expiresAt,
      livemode: false,
    });
  });

  it('expireCheckoutSession: EXPIRED, ALREADY_COMPLETE, ALREADY_EXPIRED', async () => {
    replies.push({ status: 200, body: sessionJson({ status: 'expired' }) });
    expect(await provider().expireCheckoutSession('cs_test_1')).toBe('EXPIRED');
    expect(captured[0]?.path).toBe('/v1/checkout/sessions/cs_test_1/expire');

    for (const [status, expected] of [
      ['complete', 'ALREADY_COMPLETE'],
      ['expired', 'ALREADY_EXPIRED'],
    ] as const) {
      replies.push(
        { status: 400, body: stripeError('invalid_request_error') },
        { status: 200, body: sessionJson({ status }) },
      );
      expect(await provider().expireCheckoutSession('cs_test_1')).toBe(expected);
    }
    // A 400 while the session is still open is a real error.
    replies.push(
      { status: 400, body: stripeError('invalid_request_error') },
      { status: 200, body: sessionJson({ status: 'open' }) },
    );
    await expect(provider().expireCheckoutSession('cs_test_1')).rejects.toBeInstanceOf(
      PaymentInvalidRequestError,
    );
  });

  it('createRefund sends payment_intent, amount, metadata.refundId, reason and the key', async () => {
    replies.push({
      status: 200,
      body: {
        id: 're_1',
        object: 'refund',
        amount: 1999,
        currency: 'usd',
        status: 'pending',
        metadata: { refundId: 'rf_1', orderId: 'ord_1' },
        payment_intent: 'pi_1',
        failure_reason: null,
      },
    });
    const refund = await provider().createRefund(
      {
        paymentIntentId: 'pi_1',
        amountMinor: 1999,
        refundId: 'rf_1',
        reason: 'requested_by_customer',
        metadata: { orderId: 'ord_1' },
      },
      { idempotencyKey: refundIdempotencyKey('rf_1', 2) },
    );
    const [request] = captured;
    expect(request?.path).toBe('/v1/refunds');
    expect(request?.headers['idempotency-key']).toBe('refund:rf_1:2');
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      payment_intent: 'pi_1',
      amount: '1999',
      'metadata[orderId]': 'ord_1',
      'metadata[refundId]': 'rf_1',
      reason: 'requested_by_customer',
    });
    expect(refund).toEqual({
      providerRefundId: 're_1',
      status: 'PENDING',
      providerStatus: 'pending',
      refundId: 'rf_1',
      paymentIntentId: 'pi_1',
      amountMinor: 1999,
      currency: 'USD',
      failureReason: null,
    });
  });

  it('retrieveRefund maps a failed refund', async () => {
    replies.push({
      status: 200,
      body: {
        id: 're_2',
        object: 'refund',
        amount: 500,
        currency: 'usd',
        status: 'failed',
        metadata: {},
        payment_intent: { id: 'pi_2' },
        failure_reason: 'lost_or_stolen_card',
      },
    });
    expect(await provider().retrieveRefund('re_2')).toMatchObject({
      status: 'FAILED',
      refundId: null,
      paymentIntentId: 'pi_2',
      failureReason: 'lost_or_stolen_card',
    });
  });
});

describe('StripePaymentProvider: typed errors', () => {
  const cases: [string, Reply, new (...args: never[]) => Error][] = [
    [
      '500 api_error',
      { status: 500, body: stripeError('api_error') },
      PaymentProviderUnavailableError,
    ],
    ['503', { status: 503, body: stripeError('api_error') }, PaymentProviderUnavailableError],
    [
      '429 rate limit',
      { status: 429, body: stripeError('invalid_request_error', { code: 'rate_limit' }) },
      PaymentProviderUnavailableError,
    ],
    [
      '409 lock_timeout',
      { status: 409, body: stripeError('invalid_request_error', { code: 'lock_timeout' }) },
      PaymentProviderUnavailableError,
    ],
    [
      '400 idempotency_error',
      { status: 400, body: stripeError('idempotency_error') },
      PaymentIdempotencyError,
    ],
    [
      '402 card_error',
      { status: 402, body: stripeError('card_error', { code: 'card_declined' }) },
      PaymentCardError,
    ],
    [
      '401',
      { status: 401, body: stripeError('invalid_request_error') },
      PaymentAuthenticationError,
    ],
    [
      '403',
      { status: 403, body: stripeError('invalid_request_error') },
      PaymentAuthenticationError,
    ],
    [
      '404 resource_missing',
      {
        status: 404,
        body: stripeError('invalid_request_error', { code: 'resource_missing', param: 'id' }),
      },
      PaymentResourceNotFoundError,
    ],
    [
      '400 invalid request',
      {
        status: 400,
        body: stripeError('invalid_request_error', { code: 'parameter_unknown', param: 'foo' }),
      },
      PaymentInvalidRequestError,
    ],
  ];

  it.each(cases)('%s', async (_name, reply, type) => {
    replies.push(reply);
    const error = await provider()
      .retrieveCheckoutSession('cs_test_1')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ operation: 'retrieveCheckoutSession', httpStatus: reply.status });
  });

  it('5xx/network errors are DependencyUnavailableError("stripe") (→ 503)', async () => {
    replies.push({ status: 502, body: stripeError('api_error') });
    const error = await provider()
      .createRefund(
        { paymentIntentId: 'pi_1', amountMinor: 1, refundId: 'rf_1' },
        { idempotencyKey: 'refund:rf_1:1' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect((error as DependencyUnavailableError).dependency).toBe('stripe');
  });

  it('an unreachable host is PaymentProviderUnavailableError', async () => {
    // Port 9 (discard) on loopback is closed on dev machines and CI runners.
    const unreachable = new StripePaymentProvider({
      secretKey: 'sk_test_unit',
      apiBaseUrl: 'http://127.0.0.1:9',
      maxNetworkRetries: 0,
    });
    const error = await unreachable.retrieveRefund('re_1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentProviderUnavailableError);
    expect(error).toBeInstanceOf(DependencyUnavailableError);
  });

  it('rejects invalid input before any network call', async () => {
    const p = provider();
    await expect(
      p.createCheckoutSession({ ...input, lines: [] }, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentUsageError);
    await expect(
      p.createCheckoutSession(
        { ...input, lines: [{ name: 'x', unitAmountMinor: 19.99 }] },
        { idempotencyKey: 'k' },
      ),
    ).rejects.toBeInstanceOf(PaymentUsageError);
    await expect(
      p.createCheckoutSession({ ...input, currency: 'usd' }, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentUsageError);
    await expect(p.createCheckoutSession(input, { idempotencyKey: '' })).rejects.toBeInstanceOf(
      PaymentUsageError,
    );
    await expect(
      p.createRefund(
        { paymentIntentId: 'pi_1', amountMinor: 0, refundId: 'rf_1' },
        { idempotencyKey: 'k' },
      ),
    ).rejects.toBeInstanceOf(PaymentUsageError);
    expect(captured).toHaveLength(0);
  });
});
