import type Stripe from 'stripe';
import { PaymentInvalidRequestError, PaymentProviderError, PaymentUsageError } from '../errors';
import type {
  CheckoutPaymentStatus,
  CheckoutSessionCreated,
  CheckoutSessionStatus,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ExpireCheckoutSessionResult,
  IdempotentRequestOptions,
  PaymentProvider,
  ProviderCheckoutSession,
  ProviderRefund,
} from '../payment-provider';
import { mapRefundStatus } from '../payment-provider';
import { normalizeCurrency } from '../webhook/normalize';
import type { ProviderEvent } from '../webhook/provider-event';
import { verifyStripeWebhook } from '../webhook/verify-webhook';
import type { StripeProviderConfig } from './stripe-config';
import { createStripeClient } from './stripe-config';
import { toPaymentError } from './stripe-errors';

/** Stripe metadata limits: 50 keys, 40-char keys, 500-char values. */
const METADATA_MAX_KEYS = 50;
const METADATA_MAX_KEY_LENGTH = 40;
const METADATA_MAX_VALUE_LENGTH = 500;
const MAX_LINE_ITEMS = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const CURRENCY = /^[A-Z]{3}$/;

function assertIdempotencyKey(options: IdempotentRequestOptions): string {
  const key = options.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PaymentUsageError('idempotencyKey must be 1–255 characters');
  }
  return key;
}

function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PaymentUsageError(`${what} must be a non-empty string`);
  }
}

function assertMinorUnits(value: number, what: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new PaymentUsageError(`${what} must be an integer number of minor units ≥ ${min}`);
  }
}

function assertHttpUrl(value: string, what: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentUsageError(`${what} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PaymentUsageError(`${what} must be http(s)`);
  }
}

function metadataWith(
  extra: Readonly<Record<string, string>> | undefined,
  reservedKey: string,
  reservedValue: string,
): Record<string, string> {
  const metadata: Record<string, string> = { ...extra, [reservedKey]: reservedValue };
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_KEYS) {
    throw new PaymentUsageError(`metadata has more than ${METADATA_MAX_KEYS} keys`);
  }
  for (const [key, value] of entries) {
    if (key === '' || key.length > METADATA_MAX_KEY_LENGTH || key.includes('[')) {
      throw new PaymentUsageError(`metadata key "${key}" is invalid`);
    }
    if (typeof value !== 'string' || value.length > METADATA_MAX_VALUE_LENGTH) {
      throw new PaymentUsageError(`metadata.${key} must be a string ≤ 500 characters`);
    }
  }
  return metadata;
}

/**
 * The exact Checkout Session create parameters (design §3). Exported so the stripe-mock contract
 * test and the emulator assert the very same shape the adapter sends.
 *
 * Design note: API `2026-09-30.endive` REMOVED `payment_method_types` from session create; we use
 * `allowed_payment_method_types: ['card']` (a filter on the dynamic set). Cards are synchronous,
 * so `checkout.session.completed` still implies `payment_status = 'paid'` for our sessions.
 */
export function buildCheckoutSessionParams(
  input: CreateCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  assertNonEmpty(input.orderId, 'orderId');
  if (!CURRENCY.test(input.currency)) {
    throw new PaymentUsageError('currency must be an upper-case ISO 4217 code');
  }
  if (input.lines.length === 0 || input.lines.length > MAX_LINE_ITEMS) {
    throw new PaymentUsageError(`lines must have 1–${MAX_LINE_ITEMS} items`);
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new PaymentUsageError('expiresAt must be a valid Date');
  }
  assertHttpUrl(input.successUrl, 'successUrl');
  assertHttpUrl(input.cancelUrl, 'cancelUrl');
  const currency = input.currency.toLowerCase();
  const metadata = metadataWith(input.metadata, 'orderId', input.orderId);
  const lineItems = input.lines.map((line, index): Stripe.Checkout.SessionCreateParams.LineItem => {
    assertNonEmpty(line.name, `lines[${index}].name`);
    if (line.name.length > 250) throw new PaymentUsageError(`lines[${index}].name is too long`);
    assertMinorUnits(line.unitAmountMinor, `lines[${index}].unitAmountMinor`, 0);
    const quantity = line.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new PaymentUsageError(`lines[${index}].quantity must be a positive integer`);
    }
    return {
      quantity,
      price_data: {
        currency,
        unit_amount: line.unitAmountMinor,
        product_data: { name: line.name },
      },
    };
  });
  return {
    mode: 'payment',
    allowed_payment_method_types: ['card'],
    client_reference_id: input.orderId,
    metadata,
    payment_intent_data: { metadata: { ...metadata } },
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
    ...(input.customerEmail === null ? {} : { customer_email: input.customerEmail }),
  };
}

/** The exact refund create parameters. `metadata.refundId` is what refund webhooks map back by. */
export function buildRefundParams(input: CreateRefundInput): Stripe.RefundCreateParams {
  assertNonEmpty(input.paymentIntentId, 'paymentIntentId');
  assertNonEmpty(input.refundId, 'refundId');
  assertMinorUnits(input.amountMinor, 'amountMinor', 1);
  return {
    payment_intent: input.paymentIntentId,
    amount: input.amountMinor,
    metadata: metadataWith(input.metadata, 'refundId', input.refundId),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

function sessionStatus(value: Stripe.Checkout.Session['status']): CheckoutSessionStatus {
  if (value === 'complete') return 'complete';
  return value === 'expired' ? 'expired' : 'open';
}

function sessionPaymentStatus(
  value: Stripe.Checkout.Session['payment_status'],
): CheckoutPaymentStatus {
  if (value === 'paid') return 'paid';
  return value === 'no_payment_required' ? 'no_payment_required' : 'unpaid';
}

export function toProviderCheckoutSession(
  session: Stripe.Checkout.Session,
): ProviderCheckoutSession {
  return {
    sessionId: session.id,
    status: sessionStatus(session.status),
    paymentStatus: sessionPaymentStatus(session.payment_status),
    orderId: session.metadata?.orderId ?? null,
    clientReferenceId: session.client_reference_id,
    paymentIntentId: idOf(session.payment_intent),
    amountTotalMinor: session.amount_total,
    currency: normalizeCurrency(session.currency),
    url: session.url,
    expiresAt: new Date(session.expires_at * 1000),
    livemode: session.livemode,
  };
}

export function toProviderRefund(refund: Stripe.Refund): ProviderRefund {
  const providerStatus = refund.status ?? 'pending';
  return {
    providerRefundId: refund.id,
    status: mapRefundStatus(providerStatus),
    providerStatus,
    refundId: refund.metadata?.refundId ?? null,
    paymentIntentId: idOf(refund.payment_intent),
    amountMinor: refund.amount,
    currency: normalizeCurrency(refund.currency) ?? '',
    failureReason: refund.failure_reason ?? null,
  };
}

/**
 * The Stripe adapter for `PaymentProvider` (official `stripe` SDK, pinned `apiVersion`).
 * Bind it in the api as `{ provide: PAYMENT_PROVIDER, useFactory: () => new
 * StripePaymentProvider(stripeProviderConfigFromEnv()) }`. Every method throws typed errors only.
 */
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;

  /** Pass a config, or an already-built client (tests). */
  constructor(configOrClient: StripeProviderConfig | Stripe) {
    this.stripe =
      'checkout' in configOrClient
        ? configOrClient
        : createStripeClient(configOrClient as StripeProviderConfig);
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
    options: IdempotentRequestOptions,
  ): Promise<CheckoutSessionCreated> {
    const params = buildCheckoutSessionParams(input);
    const idempotencyKey = assertIdempotencyKey(options);
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    } catch (error) {
      throw toPaymentError(error, 'createCheckoutSession');
    }
    if (session.url === null) {
      throw new PaymentProviderError('unknown', 'Stripe returned a Checkout Session without url', {
        operation: 'createCheckoutSession',
      });
    }
    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession> {
    assertNonEmpty(sessionId, 'sessionId');
    try {
      return toProviderCheckoutSession(await this.stripe.checkout.sessions.retrieve(sessionId));
    } catch (error) {
      throw toPaymentError(error, 'retrieveCheckoutSession');
    }
  }

  async expireCheckoutSession(sessionId: string): Promise<ExpireCheckoutSessionResult> {
    assertNonEmpty(sessionId, 'sessionId');
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
      return 'EXPIRED';
    } catch (error) {
      const mapped = toPaymentError(error, 'expireCheckoutSession');
      // Stripe answers 400 "only open sessions can be expired": classify by the current state.
      if (!(mapped instanceof PaymentInvalidRequestError)) throw mapped;
      const current = await this.retrieveCheckoutSession(sessionId);
      if (current.status === 'complete') return 'ALREADY_COMPLETE';
      if (current.status === 'expired') return 'ALREADY_EXPIRED';
      throw mapped;
    }
  }

  async createRefund(
    input: CreateRefundInput,
    options: IdempotentRequestOptions,
  ): Promise<ProviderRefund> {
    const params = buildRefundParams(input);
    const idempotencyKey = assertIdempotencyKey(options);
    try {
      return toProviderRefund(await this.stripe.refunds.create(params, { idempotencyKey }));
    } catch (error) {
      throw toPaymentError(error, 'createRefund');
    }
  }

  async retrieveRefund(providerRefundId: string): Promise<ProviderRefund> {
    assertNonEmpty(providerRefundId, 'providerRefundId');
    try {
      return toProviderRefund(await this.stripe.refunds.retrieve(providerRefundId));
    } catch (error) {
      throw toPaymentError(error, 'retrieveRefund');
    }
  }

  verifyWebhook(
    rawBody: Buffer,
    signatureHeader: string | readonly string[] | undefined,
    secret: string,
    toleranceSeconds?: number,
    now?: Date,
  ): ProviderEvent {
    return verifyStripeWebhook(rawBody, signatureHeader, secret, toleranceSeconds, now);
  }
}
