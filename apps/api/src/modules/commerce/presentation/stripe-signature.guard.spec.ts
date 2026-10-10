import { createHash } from 'node:crypto';
import { type ExecutionContext, HttpException } from '@nestjs/common';
import { ErrorCode } from '@udemy/contracts';
import { StripePaymentProvider } from '@udemy/payments';
import {
  checkoutSessionCompletedEvent,
  randomWebhookSecret,
  signedWebhookRequest,
  signTestWebhook,
} from '@udemy/payments/testing';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { webhookSignatureProviderOf } from '../../../shared/auth';
import { CommerceSettings } from '../application/commerce-settings';
import { StripeSignatureGuard, verifiedStripeEventOf } from './stripe-signature.guard';

/*
 * The guard with the REAL adapter's verification (pure, no network): real HMAC over the exact
 * bytes, 300 s tolerance in both directions.
 */
const secret = randomWebhookSecret();
const guard = new StripeSignatureGuard(
  new StripePaymentProvider({ secretKey: 'sk_test_guard_spec' }),
  CommerceSettings.defaults({ webhookSecret: secret, webhookToleranceSeconds: 300 }),
);

function contextFor(req: Partial<Request> & { rawBody?: unknown }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(400);
    expect(http.getResponse()).toEqual({ code: ErrorCode.WebhookSignatureInvalid });
    return;
  }
  throw new Error('expected webhook_signature_invalid');
}

const event = checkoutSessionCompletedEvent({ orderId: '01a1244b-642c-78d7-857a-31689e50a790' });

describe('StripeSignatureGuard', () => {
  it('is tagged as the stripe signature verifier (the route auditor relies on it)', () => {
    expect(webhookSignatureProviderOf(StripeSignatureGuard)).toBe('stripe');
  });

  it('accepts the exact signed bytes and hands the verified event + body digest to the handler', () => {
    const signed = signedWebhookRequest(event, secret);
    const req = { rawBody: signed.body, headers: signed.headers } as unknown as Request;
    expect(guard.canActivate(contextFor(req))).toBe(true);
    const verified = verifiedStripeEventOf(req);
    expect(verified.event.id).toBe(event.id);
    expect(verified.event.data.type).toBe('checkout.session.completed');
    expect(verified.payloadSha256).toEqual(createHash('sha256').update(signed.body).digest());
  });

  it('rejects a missing raw body, a missing header, a tampered byte, a re-serialized body, a wrong secret and stale or future timestamps', () => {
    const signed = signedWebhookRequest(event, secret);
    const headers = signed.headers;
    expectInvalid(() => guard.canActivate(contextFor({ headers } as Partial<Request>)));
    expectInvalid(() =>
      guard.canActivate(contextFor({ rawBody: signed.body, headers: {} } as Partial<Request>)),
    );
    const tampered = Buffer.from(signed.body);
    tampered[tampered.length - 2] = 0x20;
    expectInvalid(() =>
      guard.canActivate(contextFor({ rawBody: tampered, headers } as Partial<Request>)),
    );
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(signed.body.toString('utf8'))),
      'utf8',
    );
    expect(reserialized.equals(signed.body)).toBe(true); // same bytes: proves the next case is about formatting
    const pretty = Buffer.from(
      JSON.stringify(JSON.parse(signed.body.toString('utf8')), null, 1),
      'utf8',
    );
    expectInvalid(() =>
      guard.canActivate(contextFor({ rawBody: pretty, headers } as Partial<Request>)),
    );
    const wrong = { 'stripe-signature': signTestWebhook(signed.body, randomWebhookSecret()) };
    expectInvalid(() =>
      guard.canActivate(contextFor({ rawBody: signed.body, headers: wrong } as Partial<Request>)),
    );
    const now = Math.floor(Date.now() / 1000);
    for (const t of [now - 301, now + 301]) {
      const header = { 'stripe-signature': signTestWebhook(signed.body, secret, t) };
      expectInvalid(() =>
        guard.canActivate(
          contextFor({ rawBody: signed.body, headers: header } as Partial<Request>),
        ),
      );
    }
  });

  it('accepts several v1 signatures when one of them is valid (secret rolling)', () => {
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    const header = {
      'stripe-signature': signTestWebhook(body, secret, undefined, {
        extraSignatures: ['0'.repeat(64)],
      }),
    };
    expect(
      guard.canActivate(contextFor({ rawBody: body, headers: header } as Partial<Request>)),
    ).toBe(true);
  });

  it('verifiedStripeEventOf fails closed when the guard did not run', () => {
    expect(() => verifiedStripeEventOf({} as Request)).toThrow(/did not run/);
  });
});
