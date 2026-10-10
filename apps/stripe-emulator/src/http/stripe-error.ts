/**
 * Stripe's error envelope: `{ "error": { type, code?, param?, message, doc_url? } }` with Stripe's
 * status codes, so the SDK raises the same error classes it would against api.stripe.com:
 * 400/404 → StripeInvalidRequestError (or StripeIdempotencyError for `idempotency_error`),
 * 401 → StripeAuthenticationError, 402 → StripeCardError, 5xx → StripeAPIError.
 */
export type StripeErrorType =
  'api_error' | 'card_error' | 'idempotency_error' | 'invalid_request_error';

export interface StripeErrorBody {
  readonly type: StripeErrorType;
  readonly message: string;
  readonly code?: string;
  readonly param?: string;
  readonly doc_url?: string;
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: StripeErrorBody,
  ) {
    super(body.message);
    this.name = 'StripeApiError';
  }

  toJSON(): { error: StripeErrorBody } {
    return { error: this.body };
  }
}

function docUrl(code: string): string {
  return `https://docs.stripe.com/error-codes/${code.replace(/_/g, '-')}`;
}

export function invalidRequest(message: string, code?: string, param?: string): StripeApiError {
  return new StripeApiError(400, {
    type: 'invalid_request_error',
    message,
    ...(code === undefined ? {} : { code, doc_url: docUrl(code) }),
    ...(param === undefined ? {} : { param }),
  });
}

export function unknownParameter(param: string): StripeApiError {
  return invalidRequest(`Received unknown parameter: ${param}`, 'parameter_unknown', param);
}

export function missingParameter(param: string): StripeApiError {
  return invalidRequest(`Missing required param: ${param}.`, 'parameter_missing', param);
}

export function resourceMissing(kind: string, id: string, param?: string): StripeApiError {
  // A missing id in the URL is a 404; a missing id referenced by a body parameter is a 400.
  return new StripeApiError(param === undefined ? 404 : 400, {
    type: 'invalid_request_error',
    code: 'resource_missing',
    doc_url: docUrl('resource_missing'),
    message: `No such ${kind}: '${id}'`,
    ...(param === undefined ? {} : { param }),
  });
}

export function unrecognizedUrl(method: string, path: string): StripeApiError {
  return new StripeApiError(404, {
    type: 'invalid_request_error',
    message:
      `Unrecognized request URL (${method}: ${path}). The Stripe emulator implements only ` +
      'the Checkout Session and Refund subset used by @udemy/payments.',
  });
}

export function authenticationRequired(): StripeApiError {
  return new StripeApiError(401, {
    type: 'invalid_request_error',
    message:
      'You did not provide an API key. You need to provide your API key in the Authorization ' +
      'header, using Bearer auth (e.g. "Authorization: Bearer YOUR_SECRET_KEY").',
  });
}

export function invalidApiKey(key: string): StripeApiError {
  const masked = key.length > 12 ? `${key.slice(0, 8)}${'*'.repeat(8)}${key.slice(-4)}` : '****';
  return new StripeApiError(401, {
    type: 'invalid_request_error',
    code: 'api_key_invalid',
    message: `Invalid API Key provided: ${masked}`,
  });
}

export function idempotencyMismatch(key: string): StripeApiError {
  return new StripeApiError(400, {
    type: 'idempotency_error',
    message:
      'Keys for idempotent requests can only be used with the same parameters they were first ' +
      `used with. Try using a key other than '${key}' if you meant to execute a different request.`,
  });
}

export function internalError(): StripeApiError {
  return new StripeApiError(500, {
    type: 'api_error',
    message: 'An unexpected error occurred in the Stripe emulator.',
  });
}
