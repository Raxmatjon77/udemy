import {
  PaymentIdempotencyError,
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  PaymentResourceNotFoundError,
  PaymentUsageError,
} from '../errors.js';
import type {
  CheckoutSessionCreated,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ExpireCheckoutSessionResult,
  IdempotentRequestOptions,
  PaymentProvider,
  ProviderCheckoutSession,
  ProviderRefund,
  ProviderRefundStatus,
} from '../payment-provider.js';
import {
  buildCheckoutSessionParams,
  buildRefundParams,
} from '../stripe/stripe-payment-provider.js';
import type { ProviderEvent } from '../webhook/provider-event.js';
import { verifyStripeWebhook } from '../webhook/verify-webhook.js';
import type { StripeEventJson } from './fixtures.mjs';
import {
  checkoutSessionCompletedEvent,
  checkoutSessionExpiredEvent,
  fakeStripeId,
  refundFailedEvent,
  refundUpdatedEvent,
} from './fixtures.mjs';

export type InMemoryOperation =
  | 'createCheckoutSession'
  | 'retrieveCheckoutSession'
  | 'expireCheckoutSession'
  | 'createRefund'
  | 'retrieveRefund';

export interface InMemoryCall {
  readonly operation: InMemoryOperation;
  readonly args: readonly unknown[];
  readonly idempotencyKey: string | null;
}

interface StoredSession {
  session: ProviderCheckoutSession;
  readonly lineTotalMinor: number;
}

interface StoredRefund {
  refund: ProviderRefund;
}

export interface InMemoryPaymentProviderOptions {
  /** The clock used for session expiry checks. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Hosted page base URL. Default `https://checkout.test/pay/`. */
  readonly checkoutBaseUrl?: string;
  /** The status `createRefund` returns. Default `PENDING` (Stripe usually answers `pending`). */
  readonly refundOutcome?: ProviderRefundStatus;
}

function rawStatus(status: ProviderRefundStatus): 'pending' | 'succeeded' | 'failed' {
  return status === 'SUCCEEDED' ? 'succeeded' : status === 'FAILED' ? 'failed' : 'pending';
}

/**
 * A stateful, deterministic fake of `PaymentProvider` for unit tests of the commerce use cases.
 * It applies the SAME input validation as the Stripe adapter (it builds the same Stripe params),
 * the same idempotency semantics (same key + same params → same result; same key + different
 * params → `PaymentIdempotencyError`), and REAL webhook verification.
 *
 * Test controls: `failNext`, `completeSession`, `expireSessionNow`, `setRefundStatus`,
 * `registerPayment`, the `calls` log and the `*Event` builders (Stripe-shaped event JSON).
 */
export class InMemoryPaymentProvider implements PaymentProvider {
  readonly calls: InMemoryCall[] = [];
  refundOutcome: ProviderRefundStatus;

  private readonly sessions = new Map<string, StoredSession>();
  private readonly refunds = new Map<string, StoredRefund>();
  /** paymentIntentId → { captured, refunded, currency } */
  private readonly payments = new Map<
    string,
    { amountMinor: number; refundedMinor: number; currency: string }
  >();
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly failures = new Map<InMemoryOperation, Error[]>();
  private readonly now: () => Date;
  private readonly checkoutBaseUrl: string;

  constructor(options: InMemoryPaymentProviderOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
    this.checkoutBaseUrl = options.checkoutBaseUrl ?? 'https://checkout.test/pay/';
    this.refundOutcome = options.refundOutcome ?? 'PENDING';
  }

  // ---------------------------------------------------------------- test controls

  /** The next call of `operation` throws `error` (default: provider unavailable → 503). */
  failNext(operation: InMemoryOperation, error?: Error): void {
    const queue = this.failures.get(operation) ?? [];
    queue.push(error ?? new PaymentProviderUnavailableError({ operation }));
    this.failures.set(operation, queue);
  }

  /** Marks a session complete+paid (what the hosted page does) and registers its payment. */
  completeSession(
    sessionId: string,
    options: { paymentIntentId?: string } = {},
  ): ProviderCheckoutSession {
    const stored = this.requireSession(sessionId);
    if (stored.session.status !== 'open') {
      throw new PaymentInvalidRequestError(`session ${sessionId} is ${stored.session.status}`, {
        operation: 'completeSession',
      });
    }
    const paymentIntentId = options.paymentIntentId ?? fakeStripeId('pi');
    stored.session = {
      ...stored.session,
      status: 'complete',
      paymentStatus: stored.lineTotalMinor === 0 ? 'no_payment_required' : 'paid',
      paymentIntentId,
      url: null,
    };
    this.registerPayment(paymentIntentId, stored.lineTotalMinor, stored.session.currency ?? 'USD');
    return stored.session;
  }

  /** Expires an open session as Stripe does at `expires_at`. */
  expireSessionNow(sessionId: string): ProviderCheckoutSession {
    const stored = this.requireSession(sessionId);
    if (stored.session.status === 'open') {
      stored.session = { ...stored.session, status: 'expired', url: null };
    }
    return stored.session;
  }

  /** Makes a payment intent refundable without going through a session. */
  registerPayment(paymentIntentId: string, amountMinor: number, currency = 'USD'): void {
    this.payments.set(paymentIntentId, { amountMinor, refundedMinor: 0, currency });
  }

  /** Moves a refund to a new status (what Stripe does asynchronously). */
  setRefundStatus(
    providerRefundId: string,
    status: ProviderRefundStatus,
    failureReason: string | null = status === 'FAILED' ? 'expired_or_canceled_card' : null,
  ): ProviderRefund {
    const stored = this.refunds.get(providerRefundId);
    if (stored === undefined) throw new Error(`unknown refund ${providerRefundId}`);
    stored.refund = {
      ...stored.refund,
      status,
      providerStatus: rawStatus(status),
      failureReason: status === 'FAILED' ? failureReason : null,
    };
    return stored.refund;
  }

  session(sessionId: string): ProviderCheckoutSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  refund(providerRefundId: string): ProviderRefund | undefined {
    return this.refunds.get(providerRefundId)?.refund;
  }

  /** `checkout.session.completed` JSON for a session's current state (complete it first). */
  checkoutCompletedEvent(sessionId: string): StripeEventJson {
    const { session } = this.requireSession(sessionId);
    return checkoutSessionCompletedEvent({
      sessionId,
      orderId: session.orderId,
      clientReferenceId: session.clientReferenceId,
      amountTotalMinor: session.amountTotalMinor ?? 0,
      currency: session.currency ?? 'USD',
      paymentIntentId: session.paymentIntentId,
      paymentStatus: session.paymentStatus,
    });
  }

  checkoutExpiredEvent(sessionId: string): StripeEventJson {
    const { session } = this.requireSession(sessionId);
    return checkoutSessionExpiredEvent({
      sessionId,
      orderId: session.orderId,
      clientReferenceId: session.clientReferenceId,
    });
  }

  /** `refund.updated` (or `refund.failed` when FAILED) JSON for a refund's current state. */
  refundEvent(providerRefundId: string): StripeEventJson {
    const stored = this.refunds.get(providerRefundId);
    if (stored === undefined) throw new Error(`unknown refund ${providerRefundId}`);
    const { refund } = stored;
    const fixture = {
      providerRefundId,
      refundId: refund.refundId,
      paymentIntentId: refund.paymentIntentId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      status: refund.providerStatus as 'pending' | 'succeeded' | 'failed',
      failureReason: refund.failureReason,
    };
    return refund.status === 'FAILED' ? refundFailedEvent(fixture) : refundUpdatedEvent(fixture);
  }

  // ---------------------------------------------------------------- PaymentProvider

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
    options: IdempotentRequestOptions,
  ): Promise<CheckoutSessionCreated> {
    const params = buildCheckoutSessionParams(input);
    this.record('createCheckoutSession', [input], options.idempotencyKey);
    return this.idempotent('createCheckoutSession', options, params, () => {
      const sessionId = fakeStripeId('cs_test');
      const lineTotalMinor = input.lines.reduce(
        (sum, line) => sum + line.unitAmountMinor * (line.quantity ?? 1),
        0,
      );
      const url = `${this.checkoutBaseUrl}${sessionId}`;
      this.sessions.set(sessionId, {
        lineTotalMinor,
        session: {
          sessionId,
          status: 'open',
          paymentStatus: 'unpaid',
          orderId: input.orderId,
          clientReferenceId: input.orderId,
          paymentIntentId: null,
          amountTotalMinor: lineTotalMinor,
          currency: input.currency,
          url,
          expiresAt: new Date(Math.floor(input.expiresAt.getTime() / 1000) * 1000),
          livemode: false,
        },
      });
      return {
        sessionId,
        url,
        expiresAt: new Date(Math.floor(input.expiresAt.getTime() / 1000) * 1000),
      };
    });
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession> {
    this.record('retrieveCheckoutSession', [sessionId], null);
    const stored = this.requireSession(sessionId);
    if (stored.session.status === 'open' && stored.session.expiresAt <= this.now()) {
      this.expireSessionNow(sessionId);
    }
    return stored.session;
  }

  async expireCheckoutSession(sessionId: string): Promise<ExpireCheckoutSessionResult> {
    this.record('expireCheckoutSession', [sessionId], null);
    const stored = this.requireSession(sessionId);
    if (stored.session.status === 'complete') return 'ALREADY_COMPLETE';
    if (stored.session.status === 'expired') return 'ALREADY_EXPIRED';
    this.expireSessionNow(sessionId);
    return 'EXPIRED';
  }

  async createRefund(
    input: CreateRefundInput,
    options: IdempotentRequestOptions,
  ): Promise<ProviderRefund> {
    const params = buildRefundParams(input);
    this.record('createRefund', [input], options.idempotencyKey);
    const created = this.idempotent('createRefund', options, params, () => {
      const payment = this.payments.get(input.paymentIntentId);
      if (payment === undefined) {
        throw new PaymentResourceNotFoundError(`No such payment_intent: ${input.paymentIntentId}`, {
          operation: 'createRefund',
          providerCode: 'resource_missing',
          httpStatus: 404,
          param: 'payment_intent',
        });
      }
      if (payment.refundedMinor + input.amountMinor > payment.amountMinor) {
        throw new PaymentInvalidRequestError('Refund amount exceeds the remaining charge', {
          operation: 'createRefund',
          providerCode:
            payment.refundedMinor >= payment.amountMinor
              ? 'charge_already_refunded'
              : 'amount_too_large',
          httpStatus: 400,
          param: 'amount',
        });
      }
      if (this.refundOutcome !== 'FAILED') payment.refundedMinor += input.amountMinor;
      const providerRefundId = fakeStripeId('re');
      const refund: ProviderRefund = {
        providerRefundId,
        status: this.refundOutcome,
        providerStatus: rawStatus(this.refundOutcome),
        refundId: input.refundId,
        paymentIntentId: input.paymentIntentId,
        amountMinor: input.amountMinor,
        currency: payment.currency,
        failureReason: this.refundOutcome === 'FAILED' ? 'expired_or_canceled_card' : null,
      };
      this.refunds.set(providerRefundId, { refund });
      return refund;
    });
    // Like Stripe, a replay returns the ORIGINAL response (not the refund's current state).
    return created;
  }

  async retrieveRefund(providerRefundId: string): Promise<ProviderRefund> {
    this.record('retrieveRefund', [providerRefundId], null);
    const stored = this.refunds.get(providerRefundId);
    if (stored === undefined) {
      throw new PaymentResourceNotFoundError(`No such refund: ${providerRefundId}`, {
        operation: 'retrieveRefund',
        providerCode: 'resource_missing',
        httpStatus: 404,
      });
    }
    return stored.refund;
  }

  verifyWebhook(
    rawBody: Buffer,
    signatureHeader: string | readonly string[] | undefined,
    secret: string,
    toleranceSeconds?: number,
    now?: Date,
  ): ProviderEvent {
    return verifyStripeWebhook(
      rawBody,
      signatureHeader,
      secret,
      toleranceSeconds,
      now ?? this.now(),
    );
  }

  // ---------------------------------------------------------------- internals

  private record(operation: InMemoryOperation, args: readonly unknown[], key: string | null): void {
    this.calls.push({ operation, args, idempotencyKey: key });
    const queued = this.failures.get(operation)?.shift();
    if (queued !== undefined) throw queued;
  }

  private idempotent<T>(
    operation: InMemoryOperation,
    options: IdempotentRequestOptions,
    params: unknown,
    create: () => T,
  ): T {
    const key = options.idempotencyKey;
    if (typeof key !== 'string' || key.trim() === '' || key.length > 255) {
      throw new PaymentUsageError('idempotencyKey must be 1–255 characters');
    }
    // Like Stripe, keys are account-wide: reusing one on another endpoint is a conflict too.
    const fingerprint = `${operation}|${JSON.stringify(params)}`;
    const previous = this.idempotency.get(key);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new PaymentIdempotencyError(
          'Keys for idempotent requests can only be used with the same parameters',
          { operation, providerType: 'idempotency_error', httpStatus: 400 },
        );
      }
      return previous.result as T;
    }
    const result = create();
    this.idempotency.set(key, { fingerprint, result });
    return result;
  }

  private requireSession(sessionId: string): StoredSession {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) {
      throw new PaymentResourceNotFoundError(`No such checkout.session: ${sessionId}`, {
        operation: 'retrieveCheckoutSession',
        providerCode: 'resource_missing',
        httpStatus: 404,
      });
    }
    return stored;
  }
}
