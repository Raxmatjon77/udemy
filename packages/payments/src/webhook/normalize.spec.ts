import { describe, expect, it } from 'vitest';
import { WebhookSignatureInvalidError } from '../errors';
import {
  chargeDisputeCreatedEvent,
  chargeRefundedEvent,
  checkoutSessionCompletedEvent,
  checkoutSessionExpiredEvent,
  refundFailedEvent,
  refundUpdatedEvent,
  stripeEvent,
} from '../testing/index.mjs';
import { normalizeEventData, parseProviderEvent } from './normalize';
import { HANDLED_PROVIDER_EVENT_TYPES } from './provider-event';

function parse(event: unknown): ReturnType<typeof parseProviderEvent> {
  return parseProviderEvent(Buffer.from(JSON.stringify(event)));
}

describe('parseProviderEvent: envelope', () => {
  it('carries the raw id, type, created time, livemode and api version', () => {
    const created = new Date('2026-10-10T10:00:00.000Z');
    const event = checkoutSessionCompletedEvent(
      { orderId: 'ord_1' },
      { id: 'evt_123', created, livemode: false },
    );
    const parsed = parse(event);
    expect(parsed).toMatchObject({
      id: 'evt_123',
      providerType: 'checkout.session.completed',
      createdAt: created,
      livemode: false,
      apiVersion: '2026-09-30.endive',
    });
    expect(parse({ ...event, livemode: true }).livemode).toBe(true);
  });

  it.each([
    ['missing id', { id: undefined }],
    ['missing type', { type: undefined }],
    ['non-integer created', { created: '2026' }],
    ['missing livemode', { livemode: undefined }],
    ['not an event', { object: 'charge' }],
    ['missing data.object', { data: {} }],
  ])('rejects a malformed envelope: %s', (_name, patch) => {
    const event = { ...checkoutSessionCompletedEvent({ orderId: 'o' }), ...patch };
    expect(() => parse(event)).toThrow(WebhookSignatureInvalidError);
  });
});

describe('normalizeEventData', () => {
  it('checkout.session.completed', () => {
    const event = checkoutSessionCompletedEvent({
      sessionId: 'cs_test_1',
      orderId: 'ord_1',
      amountTotalMinor: 4498,
      currency: 'usd',
      paymentIntentId: 'pi_1',
    });
    expect(parse(event).data).toEqual({
      type: 'checkout.session.completed',
      sessionId: 'cs_test_1',
      orderId: 'ord_1',
      clientReferenceId: 'ord_1',
      paymentStatus: 'paid',
      paymentIntentId: 'pi_1',
      amountTotalMinor: 4498,
      currency: 'USD',
    });
  });

  it('checkout.session.completed: expanded payment_intent, missing metadata, unpaid', () => {
    const data = normalizeEventData('checkout.session.completed', {
      id: 'cs_test_2',
      payment_intent: { id: 'pi_expanded', object: 'payment_intent' },
      payment_status: 'unpaid',
      client_reference_id: 'ord_9',
      amount_total: 100,
      currency: 'usd',
    });
    expect(data).toMatchObject({
      orderId: null,
      clientReferenceId: 'ord_9',
      paymentIntentId: 'pi_expanded',
      paymentStatus: 'unpaid',
    });
  });

  it('checkout.session.expired', () => {
    const event = checkoutSessionExpiredEvent({ sessionId: 'cs_test_3', orderId: 'ord_3' });
    expect(parse(event).data).toEqual({
      type: 'checkout.session.expired',
      sessionId: 'cs_test_3',
      orderId: 'ord_3',
      clientReferenceId: 'ord_3',
    });
  });

  it('charge.refunded (partial and full)', () => {
    const partial = chargeRefundedEvent({
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 4498,
      amountRefundedMinor: 1999,
    });
    expect(parse(partial).data).toEqual({
      type: 'charge.refunded',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 4498,
      amountRefundedMinor: 1999,
      fullyRefunded: false,
      currency: 'USD',
    });
    const full = chargeRefundedEvent({ amountMinor: 1999, amountRefundedMinor: 1999 });
    expect(parse(full).data).toMatchObject({ fullyRefunded: true });
  });

  it.each([
    ['succeeded', 'SUCCEEDED'],
    ['pending', 'PENDING'],
    ['requires_action', 'PENDING'],
    ['failed', 'FAILED'],
    ['canceled', 'FAILED'],
  ] as const)('refund.updated with status %s → %s', (status, expected) => {
    const event = refundUpdatedEvent({
      providerRefundId: 're_1',
      refundId: 'rf_1',
      paymentIntentId: 'pi_1',
      amountMinor: 1999,
      status,
    });
    expect(parse(event).data).toEqual({
      type: 'refund.updated',
      providerRefundId: 're_1',
      refundId: 'rf_1',
      paymentIntentId: 'pi_1',
      status: expected,
      providerStatus: status,
      amountMinor: 1999,
      currency: 'USD',
      failureReason: status === 'failed' ? 'expired_or_canceled_card' : null,
    });
  });

  it('refund.failed is always FAILED, with the failure reason', () => {
    const event = refundFailedEvent({ providerRefundId: 're_2', refundId: null });
    expect(parse(event).data).toMatchObject({
      type: 'refund.failed',
      providerRefundId: 're_2',
      refundId: null,
      status: 'FAILED',
      failureReason: 'expired_or_canceled_card',
    });
    const inconsistent = refundFailedEvent({ refundId: 'rf_3', status: 'pending' });
    expect(parse(inconsistent).data).toMatchObject({ status: 'FAILED', providerStatus: 'pending' });
  });

  it('charge.dispute.created', () => {
    const event = chargeDisputeCreatedEvent({
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 1999,
      reason: 'fraudulent',
    });
    expect(parse(event).data).toEqual({
      type: 'charge.dispute.created',
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 1999,
      currency: 'USD',
      reason: 'fraudulent',
      status: 'needs_response',
    });
  });

  it.each([
    'refund.created',
    'checkout.session.async_payment_succeeded',
    'payment_intent.succeeded',
    'charge.dispute.closed',
    'customer.created',
    'some.future.event',
  ])('unknown or unhandled type %s → { type: "unhandled" }', (type) => {
    const parsed = parse(stripeEvent(type, { id: 'x_1', object: 'whatever' }));
    expect(parsed.data).toEqual({ type: 'unhandled' });
    expect(parsed.providerType).toBe(type);
  });

  it('a handled type missing its required id is invalid_payload', () => {
    for (const type of HANDLED_PROVIDER_EVENT_TYPES) {
      expect(() => normalizeEventData(type, {})).toThrow(WebhookSignatureInvalidError);
    }
  });
});
