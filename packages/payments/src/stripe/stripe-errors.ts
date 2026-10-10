import Stripe from 'stripe';
import type { PaymentErrorDetails } from '../errors';
import {
  PaymentAuthenticationError,
  PaymentCardError,
  PaymentConfigError,
  PaymentIdempotencyError,
  PaymentInvalidRequestError,
  PaymentProviderError,
  PaymentProviderUnavailableError,
  PaymentResourceNotFoundError,
  PaymentUsageError,
  WebhookSignatureInvalidError,
} from '../errors';

/** Stripe's codes for transient conflicts that a retry with the same key resolves. */
const RETRYABLE_CODES = new Set(['lock_timeout', 'rate_limit']);

/**
 * Translates whatever the Stripe SDK threw into a typed payment error. Already-typed errors pass
 * through unchanged. Network failures, timeouts, 429 and 5xx become
 * `PaymentProviderUnavailableError` (`DependencyUnavailableError('stripe')`, HTTP 503).
 */
export function toPaymentError(error: unknown, operation: string): Error {
  if (
    error instanceof PaymentProviderError ||
    error instanceof PaymentProviderUnavailableError ||
    error instanceof PaymentUsageError ||
    error instanceof PaymentConfigError ||
    error instanceof WebhookSignatureInvalidError
  ) {
    return error;
  }
  if (!(error instanceof Stripe.errors.StripeError)) {
    // Not from the SDK (a bug in our mapping, or a socket error the SDK did not wrap).
    return new PaymentProviderUnavailableError({ operation, cause: error });
  }
  const details: PaymentErrorDetails = {
    operation,
    providerType: error.rawType ?? error.type,
    cause: error,
    ...(error.code === undefined ? {} : { providerCode: error.code }),
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(error.statusCode === undefined ? {} : { httpStatus: error.statusCode }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  };
  const status = error.statusCode;
  const message = `Stripe ${operation} failed: ${error.code ?? error.type}${
    status === undefined ? '' : ` (HTTP ${status})`
  }`;

  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    (status !== undefined && (status >= 500 || status === 429)) ||
    (error.code !== undefined && RETRYABLE_CODES.has(error.code))
  ) {
    return new PaymentProviderUnavailableError(details);
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return new PaymentIdempotencyError(message, details);
  }
  if (error instanceof Stripe.errors.StripeCardError) {
    return new PaymentCardError(message, details);
  }
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    status === 401 ||
    status === 403
  ) {
    return new PaymentAuthenticationError(message, details);
  }
  if (status === 404 || error.code === 'resource_missing') {
    return new PaymentResourceNotFoundError(message, details);
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError || status === 400) {
    return new PaymentInvalidRequestError(message, details);
  }
  return new PaymentProviderError('unknown', message, details);
}
