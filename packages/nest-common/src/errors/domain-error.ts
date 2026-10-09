/**
 * Domain errors: thrown by domain/application code, translated to HTTP (RFC 7807) by the
 * api's global exception filter. This file must stay free of Nest/HTTP imports so the
 * domain layer can use it; import it via `@udemy/nest-common/errors`.
 *
 * `message` is shown to API clients as `detail`, so write it for users and never put
 * secrets or internals in it. `code` is a stable, machine-readable identifier.
 */
export type DomainErrorKind =
  'not_found' | 'conflict' | 'validation' | 'forbidden' | 'unauthorized';

export interface DomainErrorOptions {
  /** Stable machine-readable code, e.g. `course_not_found`. Defaults to the kind. */
  code?: string;
  cause?: unknown;
}

export interface DomainFieldIssue {
  /** Dotted path of the field, e.g. `price.amount`. */
  path: string;
  message: string;
}

export abstract class DomainError extends Error {
  readonly code: string;

  protected constructor(
    readonly kind: DomainErrorKind,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? kind;
  }
}

/** The requested entity does not exist (or the caller may not know it exists). */
export class NotFoundError extends DomainError {
  constructor(message: string, options?: DomainErrorOptions) {
    super('not_found', message, options);
  }
}

/** The request conflicts with current state: duplicate, stale version, wrong workflow state. */
export class ConflictError extends DomainError {
  constructor(message: string, options?: DomainErrorOptions) {
    super('conflict', message, options);
  }
}

/** Input is well-formed but breaks a business rule (e.g. price below the minimum). */
export class ValidationError extends DomainError {
  readonly issues: readonly DomainFieldIssue[];

  constructor(
    message: string,
    options?: DomainErrorOptions & { issues?: readonly DomainFieldIssue[] },
  ) {
    super('validation', message, options);
    this.issues = options?.issues ?? [];
  }
}

/** Authenticated, but not allowed to do this. */
export class ForbiddenError extends DomainError {
  constructor(message: string, options?: DomainErrorOptions) {
    super('forbidden', message, options);
  }
}

/** Not authenticated, or the credentials are invalid/expired. */
export class UnauthorizedError extends DomainError {
  constructor(message: string, options?: DomainErrorOptions) {
    super('unauthorized', message, options);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
