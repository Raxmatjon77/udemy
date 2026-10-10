import { ErrorCode, type ProblemCode } from '@udemy/contracts';

/**
 * 429: the caller exceeded a rate limit. Not a DomainError (its kinds have no 429), but just
 * as safe to throw from domain/application code: the global filter maps it to
 * `429 problem+json` with the given `code` and a `Retry-After` header (whole seconds, >= 1).
 *
 * `message` is shown to clients as `detail`; keep it generic (it must be identical for
 * existing and unknown accounts, design §9 "Rate limits and brute force").
 */
export class RateLimitedError extends Error {
  readonly code: ProblemCode;
  /** Seconds until the caller may retry (always >= 1). */
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    options: { code?: ProblemCode; retryAfterMs: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? ErrorCode.RateLimited;
    this.retryAfterSeconds = Math.max(1, Math.ceil(options.retryAfterMs / 1000));
  }
}
