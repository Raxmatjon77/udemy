import { WebhookSignatureInvalidError } from '../errors';
import type { CheckoutPaymentStatus } from '../payment-provider';
import { mapRefundStatus } from '../payment-provider';
import type { ProviderEvent, ProviderEventData } from './provider-event';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** An expandable field: either the id string or the expanded object with an `id`. */
function expandableId(value: unknown): string | null {
  if (typeof value === 'string') return str(value);
  return isObject(value) ? str(value.id) : null;
}

function metadataValue(object: JsonObject, key: string): string | null {
  return isObject(object.metadata) ? str(object.metadata[key]) : null;
}

/** Stripe sends lower-case ISO codes; the port speaks upper-case. */
export function normalizeCurrency(value: unknown): string | null {
  const currency = str(value);
  return currency === null ? null : currency.toUpperCase();
}

function invalid(detail: string): never {
  throw new WebhookSignatureInvalidError('invalid_payload', { cause: new Error(detail) });
}

function required<T>(value: T | null, what: string): T {
  if (value === null) invalid(`missing ${what}`);
  return value;
}

function paymentStatus(value: unknown): CheckoutPaymentStatus {
  return value === 'paid' || value === 'no_payment_required' ? value : 'unpaid';
}

/** Maps `data.object` of a Stripe event to our union. Unknown types → `{ type: 'unhandled' }`. */
export function normalizeEventData(type: string, object: JsonObject): ProviderEventData {
  switch (type) {
    case 'checkout.session.completed':
      return {
        type,
        sessionId: required(str(object.id), 'session id'),
        orderId: metadataValue(object, 'orderId'),
        clientReferenceId: str(object.client_reference_id),
        paymentStatus: paymentStatus(object.payment_status),
        paymentIntentId: expandableId(object.payment_intent),
        amountTotalMinor: int(object.amount_total),
        currency: normalizeCurrency(object.currency),
      };
    case 'checkout.session.expired':
      return {
        type,
        sessionId: required(str(object.id), 'session id'),
        orderId: metadataValue(object, 'orderId'),
        clientReferenceId: str(object.client_reference_id),
      };
    case 'charge.refunded': {
      const amountMinor = required(int(object.amount), 'charge amount');
      const amountRefundedMinor = required(int(object.amount_refunded), 'amount_refunded');
      return {
        type,
        chargeId: required(str(object.id), 'charge id'),
        paymentIntentId: expandableId(object.payment_intent),
        amountMinor,
        amountRefundedMinor,
        fullyRefunded: object.refunded === true,
        currency: required(normalizeCurrency(object.currency), 'currency'),
      };
    }
    case 'refund.updated':
    case 'refund.failed': {
      const providerStatus =
        str(object.status) ?? (type === 'refund.failed' ? 'failed' : 'pending');
      return {
        type,
        providerRefundId: required(str(object.id), 'refund id'),
        refundId: metadataValue(object, 'refundId'),
        paymentIntentId: expandableId(object.payment_intent),
        // `refund.failed` is terminal whatever the embedded status says.
        status: type === 'refund.failed' ? 'FAILED' : mapRefundStatus(providerStatus),
        providerStatus,
        amountMinor: required(int(object.amount), 'refund amount'),
        currency: required(normalizeCurrency(object.currency), 'currency'),
        failureReason: str(object.failure_reason),
      };
    }
    case 'charge.dispute.created':
      return {
        type,
        disputeId: required(str(object.id), 'dispute id'),
        chargeId: expandableId(object.charge),
        paymentIntentId: expandableId(object.payment_intent),
        amountMinor: required(int(object.amount), 'dispute amount'),
        currency: required(normalizeCurrency(object.currency), 'currency'),
        reason: str(object.reason),
        status: str(object.status),
      };
    default:
      return { type: 'unhandled' };
  }
}

/**
 * Parses an ALREADY VERIFIED raw body into a `ProviderEvent`. Throws
 * `WebhookSignatureInvalidError('invalid_payload')` when it is not a Stripe event envelope.
 */
export function parseProviderEvent(rawBody: Buffer): ProviderEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    throw new WebhookSignatureInvalidError('invalid_payload', { cause: error });
  }
  if (!isObject(parsed) || parsed.object !== 'event') invalid('not an event object');
  const id = required(str(parsed.id), 'event id');
  const providerType = required(str(parsed.type), 'event type');
  const created = required(int(parsed.created), 'event created');
  if (typeof parsed.livemode !== 'boolean') invalid('missing livemode');
  const data = parsed.data;
  if (!isObject(data) || !isObject(data.object)) invalid('missing data.object');
  return {
    id,
    providerType,
    createdAt: new Date(created * 1000),
    livemode: parsed.livemode,
    apiVersion: str(parsed.api_version),
    data: normalizeEventData(providerType, data.object),
  };
}
