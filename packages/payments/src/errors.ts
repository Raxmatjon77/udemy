import { DependencyUnavailableError } from '@udemy/nest-common/errors';

/**
 * Typed payment errors. Every call made through a `PaymentProvider` throws one of these (never a
 * raw Stripe SDK error), so commerce use cases can branch with `instanceof` without knowing Stripe
 * error types.
 *
 * - `PaymentProviderError` subclasses: the provider answered and refused the request (a 4xx).
 * - `PaymentProviderUnavailableError`: the provider could not be reached, timed out, rate-limited
 *   us (429) or answered 5xx. It extends nest-common's `DependencyUnavailableError('stripe')`, so
 *   the api's global filter maps it to `503 service_unavailable` with no extra wiring; the checkout
 *   use case maps it to `503 payment_provider_unavailable`. Retryable with the SAME idempotency key.
 * - `WebhookSignatureInvalidError`: the webhook bytes, header or timestamp did not verify (400).
 * - `PaymentUsageError`: a programming error in the caller (a non-integer amount, an empty
 *   idempotency key). Never retry it; fix the caller.
 * - `PaymentConfigError`: invalid `StripeProviderConfig` / `STRIPE_*` environment. Thrown at startup.
 *
 * Messages are for logs only (they can contain provider ids); do not send them to clients.
 */
export type PaymentErrorCode =
  | 'card_declined'
  | 'invalid_request'
  | 'not_found'
  | 'idempotency_conflict'
  | 'authentication'
  | 'unknown';

export interface PaymentErrorDetails {
  /** The `PaymentProvider` operation, e.g. `createCheckoutSession`. */
  operation: string;
  /** Stripe's error `type` (`invalid_request_error`, `card_error`, ...), when it sent one. */
  providerType?: string;
  /** Stripe's error `code` (`resource_missing`, `charge_already_refunded`, ...). */
  providerCode?: string;
  /** The offending request parameter, for invalid requests. */
  param?: string;
  httpStatus?: number;
  /** Stripe's `Request-Id`, for support tickets and log correlation. */
  requestId?: string;
  cause?: unknown;
}

export class PaymentProviderError extends Error {
  readonly provider = 'stripe';
  readonly operation: string;
  readonly providerType: string | undefined;
  readonly providerCode: string | undefined;
  readonly param: string | undefined;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    details: PaymentErrorDetails,
  ) {
    super(message, { cause: details.cause });
    this.name = new.target.name;
    this.operation = details.operation;
    this.providerType = details.providerType;
    this.providerCode = details.providerCode;
    this.param = details.param;
    this.httpStatus = details.httpStatus;
    this.requestId = details.requestId;
  }
}

/** A card was declined (Stripe `card_error`). Hosted Checkout handles cards, so this is rare. */
export class PaymentCardError extends PaymentProviderError {
  constructor(message: string, details: PaymentErrorDetails) {
    super('card_declined', message, details);
  }
}

/**
 * The provider rejected the parameters (Stripe `invalid_request_error`), e.g. an unknown parameter,
 * a refund larger than the remaining charge (`charge_already_refunded`), or an `expires_at` out of
 * range. Check `providerCode` and `param`.
 */
export class PaymentInvalidRequestError extends PaymentProviderError {
  constructor(message: string, details: PaymentErrorDetails) {
    super('invalid_request', message, details);
  }
}

/** The session, refund or payment intent does not exist (`resource_missing` / HTTP 404). */
export class PaymentResourceNotFoundError extends PaymentProviderError {
  constructor(message: string, details: PaymentErrorDetails) {
    super('not_found', message, details);
  }
}

/**
 * The idempotency key was already used with DIFFERENT parameters (Stripe `idempotency_error`), or
 * a concurrent request with the same key is still in flight. A bug in key derivation if it ever
 * happens for `checkout-session:{orderId}` / `refund:{id}:{attempt}`.
 */
export class PaymentIdempotencyError extends PaymentProviderError {
  constructor(message: string, details: PaymentErrorDetails) {
    super('idempotency_conflict', message, details);
  }
}

/** The API key is invalid or lacks permission (401/403). A configuration problem, not retryable. */
export class PaymentAuthenticationError extends PaymentProviderError {
  constructor(message: string, details: PaymentErrorDetails) {
    super('authentication', message, details);
  }
}

/** Stripe is unreachable, timed out, rate-limited us, or answered 5xx. Retryable (same key). */
export class PaymentProviderUnavailableError extends DependencyUnavailableError {
  readonly operation: string;
  readonly providerType: string | undefined;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;

  constructor(details: PaymentErrorDetails) {
    super('stripe', { cause: details.cause });
    this.operation = details.operation;
    this.providerType = details.providerType;
    this.httpStatus = details.httpStatus;
    this.requestId = details.requestId;
  }
}

export type WebhookSignatureFailure =
  | 'missing_secret'
  | 'missing_header'
  | 'malformed_header'
  | 'no_matching_signature'
  | 'timestamp_outside_tolerance'
  | 'invalid_payload';

/**
 * The webhook did not verify. Maps to `400 webhook_signature_invalid` with NO body detail; the
 * `reason` is for logs only.
 */
export class WebhookSignatureInvalidError extends Error {
  constructor(
    readonly reason: WebhookSignatureFailure,
    options: { cause?: unknown } = {},
  ) {
    super(`Webhook signature invalid: ${reason}`, { cause: options.cause });
    this.name = new.target.name;
  }
}

/** The caller asked for something this package refuses to do. A bug, not a runtime condition. */
export class PaymentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid payments configuration. Thrown at startup. */
export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
