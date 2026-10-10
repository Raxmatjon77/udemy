import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { WebhookSignatureInvalidError } from '../errors';
import {
  checkoutSessionCompletedEvent,
  randomWebhookSecret,
  signTestWebhook,
} from '../testing/index.mjs';
import { computeWebhookSignature, parseSignatureHeader, verifyWebhookSignature } from './signature';
import { verifyStripeWebhook } from './verify-webhook';

const secret = randomWebhookSecret();
const now = new Date('2026-10-10T12:00:00.000Z');
const t = Math.floor(now.getTime() / 1000);
const event = checkoutSessionCompletedEvent({ orderId: 'ord_1' }, { created: now });
// Pretty-printed like Stripe's real deliveries, so re-serializing changes whitespace.
const body = Buffer.from(JSON.stringify(event, null, 2), 'utf8');

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
    return (error as WebhookSignatureInvalidError).reason;
  }
  throw new Error('expected verification to fail');
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature and returns the parsed event', () => {
    const header = signTestWebhook(body, secret, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, header, secret, 300, now)).toBe(t);
    const parsed = verifyStripeWebhook(body, header, secret, 300, now);
    expect(parsed.id).toBe(event.id);
    expect(parsed.data.type).toBe('checkout.session.completed');
  });

  it('fails when one byte of the body is tampered with', () => {
    const header = signTestWebhook(body, secret, t);
    const tampered = Buffer.from(body);
    const index = tampered.indexOf('ord_1');
    tampered[index + 4] = '2'.charCodeAt(0);
    expect(reasonOf(() => verifyWebhookSignature(tampered, header, secret, 300, now))).toBe(
      'no_matching_signature',
    );
    // And flipping a single bit anywhere.
    const flipped = Buffer.from(body);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
    expect(reasonOf(() => verifyWebhookSignature(flipped, header, secret, 300, now))).toBe(
      'no_matching_signature',
    );
  });

  it('fails when the body is re-serialized with identical content (bytes, not objects)', () => {
    const header = signTestWebhook(body, secret, t);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    expect(JSON.parse(reserialized.toString('utf8'))).toEqual(JSON.parse(body.toString('utf8')));
    expect(reserialized.equals(body)).toBe(false);
    expect(reasonOf(() => verifyStripeWebhook(reserialized, header, secret, 300, now))).toBe(
      'no_matching_signature',
    );
    const trailingNewline = Buffer.concat([body, Buffer.from('\n')]);
    expect(reasonOf(() => verifyStripeWebhook(trailingNewline, header, secret, 300, now))).toBe(
      'no_matching_signature',
    );
  });

  it('fails for a stale timestamp beyond the tolerance, passes at the boundary', () => {
    const stale = signTestWebhook(body, secret, t - 301);
    expect(reasonOf(() => verifyWebhookSignature(body, stale, secret, 300, now))).toBe(
      'timestamp_outside_tolerance',
    );
    expect(
      verifyWebhookSignature(body, signTestWebhook(body, secret, t - 300), secret, 300, now),
    ).toBe(t - 300);
  });

  it('fails for a timestamp too far in the future (clock-skew defence)', () => {
    const future = signTestWebhook(body, secret, t + 301);
    expect(reasonOf(() => verifyWebhookSignature(body, future, secret, 300, now))).toBe(
      'timestamp_outside_tolerance',
    );
  });

  it('fails when the timestamp in the header is changed (it is part of the signed payload)', () => {
    const header = signTestWebhook(body, secret, t);
    const moved = header.replace(`t=${t}`, `t=${t - 1}`);
    expect(reasonOf(() => verifyWebhookSignature(body, moved, secret, 300, now))).toBe(
      'no_matching_signature',
    );
  });

  it('fails with the wrong secret', () => {
    const header = signTestWebhook(body, randomWebhookSecret(), t);
    expect(reasonOf(() => verifyWebhookSignature(body, header, secret, 300, now))).toBe(
      'no_matching_signature',
    );
  });

  it('accepts multiple v1 signatures when one of them is valid (secret rolling)', () => {
    const oldSecret = randomWebhookSecret();
    const header = signTestWebhook(body, oldSecret, t, { additionalSecrets: [secret] });
    expect(parseSignatureHeader(header).signatures).toHaveLength(2);
    expect(verifyWebhookSignature(body, header, secret, 300, now)).toBe(t);
    expect(verifyWebhookSignature(body, header, oldSecret, 300, now)).toBe(t);

    const garbageFirst = signTestWebhook(body, secret, t, {
      extraSignatures: ['0'.repeat(64), 'not-hex', 'abc'],
    });
    expect(verifyWebhookSignature(body, garbageFirst, secret, 300, now)).toBe(t);
  });

  it('fails when only v0 (or other schemes) carry the valid signature', () => {
    const v1 = computeWebhookSignature(body, secret, t);
    expect(
      reasonOf(() =>
        verifyWebhookSignature(body, `t=${t},v0=${v1},v1=${'0'.repeat(64)}`, secret, 300, now),
      ),
    ).toBe('no_matching_signature');
    expect(reasonOf(() => verifyWebhookSignature(body, `t=${t},v0=${v1}`, secret, 300, now))).toBe(
      'malformed_header',
    );
  });

  it('fails for a missing or empty header', () => {
    expect(reasonOf(() => verifyWebhookSignature(body, undefined, secret, 300, now))).toBe(
      'missing_header',
    );
    expect(reasonOf(() => verifyWebhookSignature(body, '', secret, 300, now))).toBe(
      'missing_header',
    );
    expect(reasonOf(() => verifyWebhookSignature(body, [], secret, 300, now))).toBe(
      'missing_header',
    );
  });

  it('fails for malformed headers', () => {
    const v1 = computeWebhookSignature(body, secret, t);
    for (const header of [
      'garbage',
      `v1=${v1}`,
      `t=${t}`,
      `t=abc,v1=${v1}`,
      `t=${t},t=${t},v1=${v1}`,
      `t=-5,v1=${v1}`,
    ]) {
      expect(reasonOf(() => verifyWebhookSignature(body, header, secret, 300, now))).toBe(
        'malformed_header',
      );
    }
    const valid = signTestWebhook(body, secret, t);
    expect(reasonOf(() => verifyWebhookSignature(body, [valid, valid], secret, 300, now))).toBe(
      'malformed_header',
    );
    expect(verifyWebhookSignature(body, [valid], secret, 300, now)).toBe(t);
  });

  it('fails closed on a missing secret, a non-Buffer body and a zero tolerance', () => {
    const header = signTestWebhook(body, secret, t);
    expect(reasonOf(() => verifyWebhookSignature(body, header, '', 300, now))).toBe(
      'missing_secret',
    );
    expect(
      reasonOf(() =>
        verifyWebhookSignature(
          JSON.parse(body.toString('utf8')) as unknown as Buffer,
          header,
          secret,
          300,
          now,
        ),
      ),
    ).toBe('invalid_payload');
    expect(() => verifyWebhookSignature(body, header, secret, 0, now)).toThrow(RangeError);
  });

  it('a verified body that is not an event is invalid_payload', () => {
    const notJson = Buffer.from('not json');
    expect(
      reasonOf(() =>
        verifyStripeWebhook(notJson, signTestWebhook(notJson, secret, t), secret, 300, now),
      ),
    ).toBe('invalid_payload');
    const notEvent = Buffer.from('{"object":"charge","id":"ch_1"}');
    expect(
      reasonOf(() =>
        verifyStripeWebhook(notEvent, signTestWebhook(notEvent, secret, t), secret, 300, now),
      ),
    ).toBe('invalid_payload');
  });

  describe('interoperates with the official stripe SDK', () => {
    it('stripe.webhooks.constructEvent accepts a signTestWebhook header', () => {
      const header = signTestWebhook(body, secret);
      const constructed = Stripe.webhooks.constructEvent(body, header, secret, 300);
      expect(constructed.id).toBe(event.id);
    });

    it('verifyWebhookSignature accepts a stripe generateTestHeaderString header', () => {
      const header = Stripe.webhooks.generateTestHeaderString({
        payload: body.toString('utf8'),
        secret,
        timestamp: t,
      });
      expect(verifyWebhookSignature(body, header, secret, 300, now)).toBe(t);
    });
  });
});
