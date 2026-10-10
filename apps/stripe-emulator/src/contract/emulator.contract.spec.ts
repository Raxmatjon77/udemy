import { randomUUID } from 'node:crypto';
import type { ProviderEvent, ProviderEventData } from '@udemy/payments';
import { refundIdempotencyKey, StripePaymentProvider } from '@udemy/payments';
import { randomWebhookSecret } from '@udemy/payments/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emulatorConfig } from '../config';
import { silentLogger } from '../logger';
import type { RunningEmulator } from '../server';
import { startEmulator } from '../server';
import type { EventSummary } from '../webhooks/dispatcher';
import type { WebhookSink } from '../testing/webhook-sink';
import { startWebhookSink } from '../testing/webhook-sink';
import { checkoutInput, definePaymentProviderContract } from './payment-provider-contract';

/**
 * The REAL `StripePaymentProvider` against the emulator, started in-process on a random port, and
 * a local webhook sink that verifies every delivery with `verifyWebhook` and the same ephemeral
 * `whsec_` secret (design D12 layers 3 and 4).
 */
const SECRET_KEY = 'sk_test_emulator_contract';
const WEBHOOK_SECRET = randomWebhookSecret();
const MAX_ATTEMPTS = 3;

let emulator: RunningEmulator;
let sink: WebhookSink;

function provider(): StripePaymentProvider {
  return new StripePaymentProvider({
    secretKey: SECRET_KEY,
    apiBaseUrl: emulator.url,
    maxNetworkRetries: 0,
  });
}

async function control(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${emulator.url}/_emulator${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(`control ${path}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function post(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  return control(path, body);
}

async function createSession(
  overrides: Parameters<typeof checkoutInput>[0] = {},
): Promise<{ sessionId: string; url: string; orderId: string; successUrl: string }> {
  const input = checkoutInput(overrides);
  const created = await provider().createCheckoutSession(input, { idempotencyKey: randomUUID() });
  return { ...created, orderId: input.orderId, successUrl: input.successUrl };
}

async function payViaPage(sessionId: string): Promise<Response> {
  return fetch(`${emulator.url}/pay/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'action=pay',
    redirect: 'manual',
  });
}

async function paidPaymentIntent(amountMinor: number): Promise<string> {
  const { sessionId } = await createSession({
    lines: [{ name: 'Course', unitAmountMinor: amountMinor }],
  });
  const result = await post(`/checkout/sessions/${sessionId}/complete`);
  const session = result.session as { payment_intent: string };
  return session.payment_intent;
}

/** The data member whose `type` includes T (`refund.updated` shares one with `refund.failed`). */
type DataOf<T extends string> = ProviderEventData extends infer D
  ? D extends { type: infer U }
    ? T extends U
      ? D
      : never
    : never
  : never;

function verifiedOfType<T extends ProviderEventData['type']>(
  type: T,
): (ProviderEvent & { data: DataOf<T> })[] {
  return sink
    .verified()
    .filter((event): event is ProviderEvent & { data: DataOf<T> } => event.data.type === type);
}

async function events(query = ''): Promise<EventSummary[]> {
  const result = await control(`/events${query}`);
  return result.data as EventSummary[];
}

beforeAll(async () => {
  const verifier = new StripePaymentProvider({
    secretKey: SECRET_KEY,
    apiBaseUrl: 'http://127.0.0.1:1',
  });
  sink = await startWebhookSink((raw, header) =>
    verifier.verifyWebhook(raw, header, WEBHOOK_SECRET),
  );
  emulator = await startEmulator(
    emulatorConfig({
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      webhookUrl: sink.url,
      webhookMaxAttempts: MAX_ATTEMPTS,
      webhookRetryBaseMs: 5,
      webhookRetryMaxMs: 20,
    }),
    { port: 0, host: '127.0.0.1' },
    { logger: silentLogger },
  );
});

afterAll(async () => {
  await emulator?.close();
  await sink?.close();
});

definePaymentProviderContract({
  name: 'stripe-emulator (in-process)',
  stateful: true,
  secretKey: SECRET_KEY,
  baseUrl: () => emulator.url,
  paidPaymentIntent,
  completeSession: async (sessionId) => {
    await post(`/checkout/sessions/${sessionId}/complete`);
  },
  failNextRefund: async (failureReason) => {
    await post('/refunds/fail-next', { failureReason });
  },
});

describe('session URL', () => {
  it('is `${publicUrl}/pay/{id}`', async () => {
    const { sessionId, url } = await createSession();
    expect(url).toBe(`${emulator.publicUrl}/pay/${sessionId}`);
  });
});

describe('hosted checkout page', () => {
  it('shows the line items and total with Pay, Decline and Cancel buttons', async () => {
    const { url } = await createSession();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('form-action');
    const html = await response.text();
    expect(html).toContain('TypeScript in depth');
    expect(html).toContain('NestJS microservices');
    expect(html).toContain('$219.98');
    expect(html).toMatch(/<button type="submit" name="action" value="pay"[^>]*>Pay<\/button>/);
    expect(html).toMatch(/value="decline"[^>]*>Decline<\/button>/);
    expect(html).toMatch(/value="cancel"[^>]*>Cancel<\/button>/);
    expect(html).not.toMatch(/<script|<link|src="http/);
  });

  it('escapes line item names', async () => {
    const { url } = await createSession({
      lines: [{ name: '<script>alert(1)</script> & "quotes"', unitAmountMinor: 1999 }],
    });
    const html = await (await fetch(url)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
  });

  it('Pay completes the session and 303-redirects to success_url with the id substituted', async () => {
    const { sessionId, successUrl } = await createSession();
    const response = await payViaPage(sessionId);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId),
    );
    const session = await provider().retrieveCheckoutSession(sessionId);
    expect(session).toMatchObject({ status: 'complete', paymentStatus: 'paid', url: null });
    expect(session.paymentIntentId).toMatch(/^pi_/);
    // A paid session's page is no longer payable.
    expect((await fetch(`${emulator.url}/pay/${sessionId}`)).status).toBe(409);
    expect((await payViaPage(sessionId)).status).toBe(409);
  });

  it('Decline keeps the session open and shows an error', async () => {
    const { sessionId } = await createSession();
    const response = await fetch(`${emulator.url}/pay/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=decline',
      redirect: 'manual',
    });
    expect(response.status).toBe(402);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Your card was declined');
    await expect(provider().retrieveCheckoutSession(sessionId)).resolves.toMatchObject({
      status: 'open',
      paymentStatus: 'unpaid',
    });
    // Paying after a decline still works.
    expect((await payViaPage(sessionId)).status).toBe(303);
  });

  it('Cancel redirects to cancel_url and leaves the session open', async () => {
    const { sessionId } = await createSession();
    const response = await fetch(`${emulator.url}/pay/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=cancel',
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3000/cart');
    await expect(provider().retrieveCheckoutSession(sessionId)).resolves.toMatchObject({
      status: 'open',
    });
  });

  it('an expired or unknown session has no payable page', async () => {
    const { sessionId } = await createSession();
    await provider().expireCheckoutSession(sessionId);
    expect((await fetch(`${emulator.url}/pay/${sessionId}`)).status).toBe(410);
    expect((await fetch(`${emulator.url}/pay/cs_test_unknown`)).status).toBe(404);
  });
});

describe('signed webhook delivery', () => {
  beforeEach(async () => {
    await emulator.webhooks.whenIdle();
    emulator.reset();
    sink.clear();
  });

  it('checkout.session.completed verifies with verifyWebhook and carries the order', async () => {
    const { sessionId, orderId } = await createSession();
    await payViaPage(sessionId);
    await emulator.webhooks.whenIdle();
    const [delivery] = sink.deliveries;
    expect(sink.deliveries).toHaveLength(1);
    expect(delivery?.verificationError).toBeNull();
    expect(delivery?.signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(delivery?.event).toMatchObject({
      providerType: 'checkout.session.completed',
      livemode: false,
      apiVersion: '2026-09-30.endive',
      data: {
        type: 'checkout.session.completed',
        sessionId,
        orderId,
        clientReferenceId: orderId,
        paymentStatus: 'paid',
        amountTotalMinor: 21998,
        currency: 'USD',
        paymentIntentId: expect.stringMatching(/^pi_/) as unknown,
      },
    });
    const [summary] = await events();
    expect(summary).toMatchObject({
      type: 'checkout.session.completed',
      status: 'delivered',
      attemptCount: 1,
    });
  });

  it('checkout.session.expired is sent for API expiry and control expiry', async () => {
    const first = await createSession();
    await provider().expireCheckoutSession(first.sessionId);
    const second = await createSession();
    await post(`/checkout/sessions/${second.sessionId}/expire`);
    await emulator.webhooks.whenIdle();
    const expired = verifiedOfType('checkout.session.expired');
    expect(expired.map((event) => event.data.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    expect(expired.map((event) => event.data.orderId)).toEqual([first.orderId, second.orderId]);
  });

  it('a refund that succeeds sends charge.refunded and refund.updated', async () => {
    const paymentIntentId = await paidPaymentIntent(4000);
    const refundId = randomUUID();
    const refund = await provider().createRefund(
      { paymentIntentId, amountMinor: 1500, refundId },
      { idempotencyKey: refundIdempotencyKey(refundId, 1) },
    );
    await emulator.webhooks.whenIdle();
    const [charge] = verifiedOfType('charge.refunded');
    expect(charge?.data).toMatchObject({
      paymentIntentId,
      amountMinor: 4000,
      amountRefundedMinor: 1500,
      fullyRefunded: false,
      currency: 'USD',
    });
    const [updated] = verifiedOfType('refund.updated');
    expect(updated?.data).toMatchObject({
      providerRefundId: refund.providerRefundId,
      refundId,
      paymentIntentId,
      status: 'SUCCEEDED',
      amountMinor: 1500,
      failureReason: null,
    });
  });

  it('a planned refund failure sends refund.failed with the failure reason', async () => {
    const paymentIntentId = await paidPaymentIntent(1999);
    await post('/refunds/fail-next', { failureReason: 'insufficient_funds' });
    const refundId = randomUUID();
    await provider().createRefund(
      { paymentIntentId, amountMinor: 1999, refundId },
      { idempotencyKey: refundIdempotencyKey(refundId, 1) },
    );
    await emulator.webhooks.whenIdle();
    expect(verifiedOfType('refund.updated')).toHaveLength(0);
    expect(verifiedOfType('charge.refunded')).toHaveLength(0);
    const [failed] = verifiedOfType('refund.failed');
    expect(failed?.data).toMatchObject({
      refundId,
      status: 'FAILED',
      failureReason: 'insufficient_funds',
    });
  });

  it('a pending refund can be settled through the control API', async () => {
    const paymentIntentId = await paidPaymentIntent(1999);
    await post('/refunds/next', { outcome: 'pending' });
    const refundId = randomUUID();
    const created = await provider().createRefund(
      { paymentIntentId, amountMinor: 1999, refundId },
      { idempotencyKey: refundIdempotencyKey(refundId, 1) },
    );
    expect(created.status).toBe('PENDING');
    await post(`/refunds/${created.providerRefundId}/settle`, { outcome: 'succeeded' });
    await expect(provider().retrieveRefund(created.providerRefundId)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    await emulator.webhooks.whenIdle();
    expect(verifiedOfType('refund.updated').map((event) => event.data.refundId)).toEqual([
      refundId,
    ]);
  });

  it('a dispute sends charge.dispute.created', async () => {
    const paymentIntentId = await paidPaymentIntent(1999);
    await post(`/payment_intents/${paymentIntentId}/dispute`, { reason: 'fraudulent' });
    await emulator.webhooks.whenIdle();
    const [dispute] = verifiedOfType('charge.dispute.created');
    expect(dispute?.data).toMatchObject({
      paymentIntentId,
      amountMinor: 1999,
      reason: 'fraudulent',
    });
  });

  it('retries non-2xx answers with backoff until delivered', async () => {
    sink.failNext(2, 500);
    const { sessionId } = await createSession();
    await payViaPage(sessionId);
    await emulator.webhooks.whenIdle();
    expect(sink.deliveries.map((delivery) => delivery.respondedWith)).toEqual([500, 500, 200]);
    const ids = new Set(sink.deliveries.map((delivery) => delivery.event?.id));
    expect(ids.size).toBe(1);
    // Every attempt is freshly signed and verifies.
    expect(sink.deliveries.every((delivery) => delivery.verificationError === null)).toBe(true);
    const [summary] = await events();
    expect(summary?.status).toBe('delivered');
    expect(summary?.attempts.map((attempt) => [attempt.kind, attempt.statusCode])).toEqual([
      ['initial', 500],
      ['retry', 500],
      ['retry', 200],
    ]);
  });

  it('gives up after the configured number of attempts', async () => {
    sink.failNext(MAX_ATTEMPTS, 503);
    const { sessionId } = await createSession();
    await payViaPage(sessionId);
    await emulator.webhooks.whenIdle();
    expect(sink.deliveries).toHaveLength(MAX_ATTEMPTS);
    const [summary] = await events('?status=failed');
    expect(summary).toMatchObject({
      status: 'failed',
      attemptCount: MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
  });

  it('redelivers an event by id: the same event id and bytes arrive again (dedupe is visible)', async () => {
    const { sessionId } = await createSession();
    await payViaPage(sessionId);
    await emulator.webhooks.whenIdle();
    const [summary] = await events();
    const result = await post(`/events/${summary?.id ?? ''}/redeliver`);
    expect(result.attempt).toMatchObject({
      kind: 'redelivery',
      statusCode: 200,
      ok: true,
      tamper: null,
    });
    expect(sink.deliveries).toHaveLength(2);
    const [original, again] = sink.deliveries;
    expect(again?.event?.id).toBe(original?.event?.id);
    expect(again?.rawBody.equals(original?.rawBody ?? Buffer.alloc(0))).toBe(true);
    expect(again?.verificationError).toBeNull();
  });

  it.each([
    ['payload', 'no_matching_signature'],
    ['signature', 'no_matching_signature'],
    ['stale_timestamp', 'timestamp_outside_tolerance'],
  ] as const)(
    'a tampered redelivery (%s) is rejected by verifyWebhook: %s',
    async (tamper, reason) => {
      const { sessionId } = await createSession();
      await payViaPage(sessionId);
      await emulator.webhooks.whenIdle();
      const [summary] = await events();
      const result = await post(`/events/${summary?.id ?? ''}/redeliver`, { tamper });
      expect(result.attempt).toMatchObject({
        kind: 'redelivery',
        tamper,
        statusCode: 400,
        ok: false,
      });
      const tampered = sink.deliveries[1];
      expect(tampered?.event).toBeNull();
      expect(tampered?.verificationError).toBe(reason);
      // Still the same event id on the wire, and the event stays delivered.
      expect(tampered?.json?.id).toBe(summary?.id);
      const [after] = await events();
      expect(after?.status).toBe('delivered');
      expect(after?.attemptCount).toBe(2);
    },
  );

  it('event ids are unique and every event is listed', async () => {
    for (let index = 0; index < 3; index += 1) {
      const { sessionId } = await createSession();
      await payViaPage(sessionId);
      const expired = await createSession();
      await provider().expireCheckoutSession(expired.sessionId);
    }
    await emulator.webhooks.whenIdle();
    const listed = await events();
    expect(listed).toHaveLength(6);
    expect(new Set(listed.map((event) => event.id)).size).toBe(6);
    expect(listed.every((event) => /^evt_/.test(event.id))).toBe(true);
    expect(await events('?type=checkout.session.expired')).toHaveLength(3);
    const detail = await control(`/events/${listed[0]?.id ?? ''}`);
    expect(detail.event).toMatchObject({ object: 'event', id: listed[0]?.id });
  });
});
