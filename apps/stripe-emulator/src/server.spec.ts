import { buildCheckoutSessionParams, STRIPE_API_VERSION } from '@udemy/payments';
import { afterEach, describe, expect, it } from 'vitest';
import { emulatorConfig } from './config';
import type { EmulatorConfig } from './config';
import { silentLogger } from './logger';
import type { RunningEmulator } from './server';
import { startEmulator } from './server';
import { stripeForm } from './testing/form-encode';

/** Raw HTTP against an in-process emulator: Stripe wire behaviour the SDK hides. */
const KEY = 'sk_test_emulator_unit';
const running: RunningEmulator[] = [];
let nowMs = Date.parse('2026-10-10T10:00:00.000Z');

async function start(overrides: Partial<EmulatorConfig> = {}): Promise<RunningEmulator> {
  const emulator = await startEmulator(
    emulatorConfig({
      secretKey: KEY,
      webhookSecret: 'whsec_unit_test_secret_000000',
      ...overrides,
    }),
    { port: 0, host: '127.0.0.1' },
    { logger: silentLogger, clock: () => nowMs },
  );
  running.push(emulator);
  return emulator;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((emulator) => emulator.close()));
  nowMs = Date.parse('2026-10-10T10:00:00.000Z');
});

function sessionParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...buildCheckoutSessionParams({
      orderId: 'ord_1',
      currency: 'USD',
      lines: [{ name: 'Course', unitAmountMinor: 1999 }],
      customerEmail: null,
      successUrl: 'http://127.0.0.1:3000/ok?s={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://127.0.0.1:3000/cart',
      expiresAt: new Date(nowMs + 31 * 60_000),
    }),
    ...overrides,
  };
}

interface Call {
  readonly status: number;
  readonly headers: Headers;
  readonly json: Record<string, unknown>;
}

async function call(
  emulator: RunningEmulator,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string>; auth?: string | null } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth !== null) headers.authorization = options.auth ?? `Bearer ${KEY}`;
  if (options.body !== undefined) headers['content-type'] ??= 'application/x-www-form-urlencoded';
  const response = await fetch(`${emulator.url}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  return {
    status: response.status,
    headers: response.headers,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function createSession(
  emulator: RunningEmulator,
  params: Record<string, unknown> = sessionParams(),
  headers: Record<string, string> = {},
): Promise<Call> {
  return call(emulator, 'POST', '/v1/checkout/sessions', { body: stripeForm(params), headers });
}

function errorOf(result: Call): Record<string, unknown> {
  return result.json.error as Record<string, unknown>;
}

describe('health and routing', () => {
  it('GET /health is 200 without auth', async () => {
    const emulator = await start();
    const response = await fetch(`${emulator.url}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('an unknown /v1 route is a Stripe-shaped 404', async () => {
    const emulator = await start();
    const result = await call(emulator, 'GET', '/v1/charges');
    expect(result.status).toBe(404);
    expect(errorOf(result)).toMatchObject({ type: 'invalid_request_error' });
    expect(String(errorOf(result).message)).toContain(
      'Unrecognized request URL (GET: /v1/charges)',
    );
    expect(result.headers.get('request-id')).toMatch(/^req_/);
  });
});

describe('authentication and version', () => {
  it('requires the configured key (Bearer or Basic)', async () => {
    const emulator = await start();
    const missing = await call(emulator, 'GET', '/v1/refunds/re_1', { auth: null });
    expect(missing.status).toBe(401);
    expect(errorOf(missing).type).toBe('invalid_request_error');
    const wrong = await call(emulator, 'GET', '/v1/refunds/re_1', {
      auth: 'Bearer sk_test_other_key_1234',
    });
    expect(wrong.status).toBe(401);
    expect(String(errorOf(wrong).message)).not.toContain('sk_test_other_key_1234');
    const basic = await call(emulator, 'GET', '/v1/refunds/re_1', {
      auth: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
    });
    expect(basic.status).toBe(404); // authenticated; the refund just does not exist
  });

  it('accepts only the pinned Stripe-Version', async () => {
    const emulator = await start();
    const ok = await createSession(emulator, sessionParams(), {
      'stripe-version': STRIPE_API_VERSION,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    const other = await createSession(emulator, sessionParams(), {
      'stripe-version': '2024-06-20',
    });
    expect(other.status).toBe(400);
    expect(errorOf(other).code).toBe('api_version_invalid');
  });

  it('rejects JSON bodies (Stripe is form-encoded)', async () => {
    const emulator = await start();
    const result = await call(emulator, 'POST', '/v1/checkout/sessions', {
      body: JSON.stringify(sessionParams()),
      headers: { 'content-type': 'application/json' },
    });
    expect(result.status).toBe(400);
  });
});

describe('POST /v1/checkout/sessions validation', () => {
  it.each([
    [
      'payment_method_types instead of allowed_payment_method_types',
      { allowed_payment_method_types: undefined, payment_method_types: ['card'] },
      { code: 'parameter_unknown', param: 'payment_method_types' },
    ],
    [
      'missing allowed_payment_method_types',
      { allowed_payment_method_types: undefined },
      { code: 'parameter_missing', param: 'allowed_payment_method_types' },
    ],
    [
      'a non-card payment method',
      { allowed_payment_method_types: ['card', 'klarna'] },
      { param: 'allowed_payment_method_types[1]' },
    ],
    ['an unknown top-level parameter', { foo: 'bar' }, { code: 'parameter_unknown', param: 'foo' }],
    [
      'an unknown nested parameter',
      { payment_intent_data: { metadata: { a: 'b' }, capture_method: 'manual' } },
      { code: 'parameter_unknown', param: 'payment_intent_data[capture_method]' },
    ],
    [
      'a line item by price id',
      { line_items: [{ quantity: 1, price: 'price_1' }] },
      { code: 'parameter_missing', param: 'line_items[0][price_data]' },
    ],
    ['mode=subscription', { mode: 'subscription' }, { param: 'mode' }],
    [
      'a non-integer unit_amount',
      {
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: '19.99', product_data: { name: 'x' } },
          },
        ],
      },
      { code: 'parameter_invalid_integer', param: 'line_items[0][price_data][unit_amount]' },
    ],
    [
      'mixed currencies',
      {
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: 1999, product_data: { name: 'a' } },
          },
          {
            quantity: 1,
            price_data: { currency: 'eur', unit_amount: 1999, product_data: { name: 'b' } },
          },
        ],
      },
      { param: 'line_items[1][price_data][currency]' },
    ],
    [
      'a total below $0.50',
      {
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: 49, product_data: { name: 'a' } },
          },
        ],
      },
      { code: 'amount_too_small' },
    ],
    [
      'no line items',
      { line_items: undefined },
      { code: 'parameter_missing', param: 'line_items' },
    ],
    [
      'a relative success_url',
      { success_url: '/ok' },
      { code: 'url_invalid', param: 'success_url' },
    ],
    ['expires_at under 30 minutes', { expires_at: 'SOON' }, { param: 'expires_at' }],
    ['expires_at over 24 hours', { expires_at: 'LATE' }, { param: 'expires_at' }],
    ['an invalid customer_email', { customer_email: 'nope' }, { code: 'email_invalid' }],
  ])('rejects %s', async (_name, patch, expected) => {
    const emulator = await start();
    const resolved: Record<string, unknown> = { ...patch };
    if (resolved.expires_at === 'SOON') resolved.expires_at = Math.floor(nowMs / 1000) + 10 * 60;
    if (resolved.expires_at === 'LATE') resolved.expires_at = Math.floor(nowMs / 1000) + 25 * 3600;
    const result = await createSession(emulator, sessionParams(resolved));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toMatchObject({ type: 'invalid_request_error', ...expected });
    expect(result.headers.get('stripe-should-retry')).toBe('false');
  });

  it('returns a Stripe-shaped session', async () => {
    const emulator = await start({ publicUrl: 'http://pay.example.test:12111' });
    const result = await createSession(emulator);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      object: 'checkout.session',
      mode: 'payment',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: 1999,
      currency: 'usd',
      client_reference_id: 'ord_1',
      metadata: { orderId: 'ord_1' },
      payment_intent: null,
      livemode: false,
      expires_at: Math.floor(nowMs / 1000) + 31 * 60,
    });
    expect(result.json.url).toBe(`http://pay.example.test:12111/pay/${String(result.json.id)}`);
    expect(String(result.json.id)).toMatch(/^cs_test_[A-Za-z0-9]{58}$/);
  });
});

describe('idempotency', () => {
  it('replays the stored response with Idempotent-Replayed', async () => {
    const emulator = await start();
    const first = await createSession(emulator, sessionParams(), { 'idempotency-key': 'k1' });
    const second = await createSession(emulator, sessionParams(), { 'idempotency-key': 'k1' });
    expect(second.json).toEqual(first.json);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('original-request')).toBe(first.headers.get('request-id'));
    expect(emulator.stripe.snapshot().sessions).toHaveLength(1);
  });

  it('the same key with other parameters (or another endpoint) is idempotency_error', async () => {
    const emulator = await start();
    await createSession(emulator, sessionParams(), { 'idempotency-key': 'k2' });
    const changed = await createSession(emulator, sessionParams({ client_reference_id: 'other' }), {
      'idempotency-key': 'k2',
    });
    expect(changed.status).toBe(400);
    expect(errorOf(changed).type).toBe('idempotency_error');
    const otherEndpoint = await call(emulator, 'POST', '/v1/refunds', {
      body: stripeForm({ payment_intent: 'pi_1' }),
      headers: { 'idempotency-key': 'k2' },
    });
    expect(errorOf(otherEndpoint).type).toBe('idempotency_error');
  });

  it('does not save a request rejected by validation', async () => {
    const emulator = await start();
    const bad = await createSession(emulator, sessionParams({ foo: 'bar' }), {
      'idempotency-key': 'k3',
    });
    expect(bad.status).toBe(400);
    const good = await createSession(emulator, sessionParams(), { 'idempotency-key': 'k3' });
    expect(good.status).toBe(200);
  });
});

describe('expiry sweep (injected clock)', () => {
  it('expires an open session at expires_at and records checkout.session.expired', async () => {
    const emulator = await start();
    const created = await createSession(emulator);
    nowMs += 31 * 60_000;
    const retrieved = await call(
      emulator,
      'GET',
      `/v1/checkout/sessions/${String(created.json.id)}`,
    );
    expect(retrieved.json).toMatchObject({ status: 'expired', url: null });
    const events = emulator.webhooks.list();
    expect(events.map((event) => [event.type, event.objectId, event.status])).toEqual([
      ['checkout.session.expired', created.json.id, 'not_configured'],
    ]);
  });

  it('a GET with unsupported query parameters is rejected', async () => {
    const emulator = await start();
    const created = await createSession(emulator);
    const result = await call(
      emulator,
      'GET',
      `/v1/checkout/sessions/${String(created.json.id)}?expand[]=line_items`,
    );
    expect(result.status).toBe(400);
    expect(errorOf(result)).toMatchObject({ code: 'parameter_unknown', param: 'expand' });
  });
});

describe('control API', () => {
  it('is mounted by default and documents its endpoints', async () => {
    const emulator = await start();
    const response = await fetch(`${emulator.url}/_emulator`);
    expect(response.status).toBe(200);
    const index = (await response.json()) as { endpoints: { method: string; path: string }[] };
    expect(index.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual(
      expect.arrayContaining([
        'POST /_emulator/checkout/sessions/:id/complete',
        'POST /_emulator/checkout/sessions/:id/expire',
        'POST /_emulator/refunds/fail-next',
        'POST /_emulator/events/:id/redeliver',
        'GET /_emulator/events',
        'POST /_emulator/reset',
      ]),
    );
  });

  it('is absent when EMULATOR_CONTROL_ENABLED=false', async () => {
    const emulator = await start({ controlEnabled: false });
    expect((await fetch(`${emulator.url}/_emulator`)).status).toBe(404);
    expect((await fetch(`${emulator.url}/_emulator/reset`, { method: 'POST' })).status).toBe(404);
  });

  it('reports conflicts and bad input as JSON errors', async () => {
    const emulator = await start();
    const unknown = await fetch(`${emulator.url}/_emulator/checkout/sessions/cs_x/complete`, {
      method: 'POST',
    });
    expect(unknown.status).toBe(404);
    const created = await createSession(emulator);
    const path = `${emulator.url}/_emulator/checkout/sessions/${String(created.json.id)}`;
    expect((await fetch(`${path}/complete`, { method: 'POST' })).status).toBe(200);
    const again = await fetch(`${path}/complete`, { method: 'POST' });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('complete') as unknown },
    });
    const bad = await fetch(`${emulator.url}/_emulator/refunds/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'maybe' }),
    });
    expect(bad.status).toBe(400);
  });

  it('reset forgets sessions, idempotency keys and events', async () => {
    const emulator = await start();
    const first = await createSession(emulator, sessionParams(), { 'idempotency-key': 'k4' });
    await fetch(`${emulator.url}/_emulator/checkout/sessions/${String(first.json.id)}/expire`, {
      method: 'POST',
    });
    expect((await fetch(`${emulator.url}/_emulator/reset`, { method: 'POST' })).status).toBe(200);
    expect(emulator.webhooks.list()).toEqual([]);
    const missing = await call(emulator, 'GET', `/v1/checkout/sessions/${String(first.json.id)}`);
    expect(missing.status).toBe(404);
    const fresh = await createSession(emulator, sessionParams(), { 'idempotency-key': 'k4' });
    expect(fresh.json.id).not.toBe(first.json.id);
  });

  it('drain reports idle', async () => {
    const emulator = await start();
    const response = await fetch(`${emulator.url}/_emulator/webhooks/drain?timeoutMs=1000`, {
      method: 'POST',
    });
    await expect(response.json()).resolves.toEqual({ idle: true });
  });
});
