import { verifyStripeWebhook } from '@udemy/payments';
import { randomWebhookSecret, signTestWebhook } from '@udemy/payments/testing';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../logger';
import { NO_REQUEST, retryDelayMs, signatureHeader, WebhookDispatcher } from './dispatcher';

describe('retryDelayMs', () => {
  it('doubles from the base and is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, 1000, 10_000))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
    expect(retryDelayMs(3, 0, 10)).toBe(0);
  });
});

describe('signatureHeader', () => {
  it('is what signTestWebhook produces and what verifyStripeWebhook accepts', () => {
    const secret = randomWebhookSecret();
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_1',
        object: 'event',
        type: 'x.y',
        created: 1_800_000_000,
        livemode: false,
        data: { object: { id: 'obj_1' } },
      }),
    );
    const header = signatureHeader(body, secret, 1_800_000_000);
    expect(header).toBe(signTestWebhook(body, secret, 1_800_000_000));
    const event = verifyStripeWebhook(body, header, secret, 300, new Date(1_800_000_000_000));
    expect(event.id).toBe('evt_1');
  });
});

function dispatcher(url: string | null): WebhookDispatcher {
  return new WebhookDispatcher({
    url,
    secret: randomWebhookSecret(),
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 1,
    timeoutMs: 1000,
    clock: () => 1_800_000_000_000,
    logger: silentLogger,
  });
}

describe('WebhookDispatcher', () => {
  it('stores events without a URL as not_configured and stays idle', async () => {
    const webhooks = dispatcher(null);
    const stored = webhooks.emit('checkout.session.completed', { id: 'cs_1' }, NO_REQUEST);
    await webhooks.whenIdle();
    expect(stored.status).toBe('not_configured');
    expect(stored.event).toMatchObject({
      object: 'event',
      api_version: '2026-09-30.endive',
      created: 1_800_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'checkout.session.completed',
    });
    expect(webhooks.list()).toHaveLength(1);
  });

  it('snapshots the data object at emit time', () => {
    const webhooks = dispatcher(null);
    const object: Record<string, unknown> = { id: 'cs_1', status: 'open' };
    const stored = webhooks.emit('checkout.session.expired', object, NO_REQUEST);
    object.status = 'changed';
    expect(stored.event.data.object.status).toBe('open');
    expect(JSON.parse(stored.body.toString('utf8'))).toEqual(stored.event);
  });

  it('marks an unreachable endpoint failed after maxAttempts', async () => {
    // Port 1 on loopback refuses connections.
    const webhooks = dispatcher('http://127.0.0.1:1/hook');
    const stored = webhooks.emit('refund.updated', { id: 're_1' }, NO_REQUEST);
    await webhooks.whenIdle();
    expect(stored.status).toBe('failed');
    expect(
      stored.attempts.map((attempt) => [attempt.kind, attempt.statusCode, attempt.ok]),
    ).toEqual([
      ['initial', null, false],
      ['retry', null, false],
    ]);
    expect(stored.attempts[0]?.error).toBeTruthy();
  });

  it('reset drops events and pending retries; redeliver of an unknown id is undefined', async () => {
    const webhooks = new WebhookDispatcher({
      url: 'http://127.0.0.1:1/hook',
      secret: randomWebhookSecret(),
      maxAttempts: 5,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
      timeoutMs: 1000,
      clock: () => Date.now(),
      logger: silentLogger,
    });
    const stored = webhooks.emit('refund.updated', { id: 're_1' }, NO_REQUEST);
    // Let the first attempt fail so a long retry timer is pending.
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (stored.status === 'retrying') resolve();
        else setTimeout(poll, 5);
      };
      poll();
    });
    webhooks.reset();
    await webhooks.whenIdle();
    expect(webhooks.list()).toEqual([]);
    expect(webhooks.redeliver(stored.event.id)).toBeUndefined();
  });
});
