import { STATUS_CODES } from 'node:http';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ProblemDetails, type ProblemFieldError } from '@udemy/contracts';
import {
  DependencyUnavailableError,
  DomainError,
  type DomainErrorKind,
} from '@udemy/nest-common/errors';
import { ZodError } from 'zod';
import { RateLimitedError } from './rate-limited.error';
import { RequestValidationException } from './request-validation.exception';

export interface ProblemMappingOptions {
  /** Include name/message/stack of unexpected errors. Never enable in production. */
  exposeInternals: boolean;
}

const DOMAIN_STATUS: Record<DomainErrorKind, HttpStatus> = {
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  // 422: the request was well-formed but breaks a business rule.
  // (Malformed requests are 400, see RequestValidationException.)
  validation: HttpStatus.UNPROCESSABLE_ENTITY,
  forbidden: HttpStatus.FORBIDDEN,
  unauthorized: HttpStatus.UNAUTHORIZED,
};

/** Keys of Nest's default HttpException body that are folded into title/detail instead. */
const NEST_BODY_KEYS = new Set(['message', 'statusCode']);

function titleFor(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/** `type: about:blank` means "the HTTP status says it all"; `code` carries the specifics. */
function baseProblem(status: number, detail?: string): ProblemDetails {
  return { type: 'about:blank', title: titleFor(status), status, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathToString(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

function fromDomainError(error: DomainError): ProblemDetails {
  const problem: ProblemDetails = {
    ...baseProblem(DOMAIN_STATUS[error.kind], error.message),
    code: error.code,
  };
  if ('issues' in error && Array.isArray(error.issues) && error.issues.length > 0) {
    problem.errors = error.issues as ProblemFieldError[];
  }
  return problem;
}

/**
 * Fail-closed (design D11, §13): when Redis or another required dependency is down, the
 * request is refused with 503 instead of skipping the check. The detail is generic; which
 * dependency failed, and why, is only logged.
 */
function fromDependencyUnavailable(): ProblemDetails {
  return {
    ...baseProblem(
      HttpStatus.SERVICE_UNAVAILABLE,
      'The service is temporarily unavailable. Please retry later.',
    ),
    code: ErrorCode.ServiceUnavailable,
  };
}

function fromZodError(error: ZodError): ProblemDetails {
  return {
    ...baseProblem(HttpStatus.BAD_REQUEST, 'Invalid input'),
    code: ErrorCode.ValidationFailed,
    errors: error.issues.map((issue) => ({
      path: pathToString(issue.path),
      message: issue.message,
    })),
  };
}

function fromHttpException(exception: HttpException): ProblemDetails {
  const status = exception.getStatus();
  const body = exception.getResponse();
  if (!isRecord(body)) {
    return baseProblem(status, typeof body === 'string' ? body : exception.message);
  }

  // Nest's default body is { statusCode, message, error: 'Not Found' }. Other keys
  // (e.g. terminus' health `info`/`details`) are kept as RFC 7807 extension members.
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const isNestErrorLabel = key === 'error' && typeof value === 'string';
    if (!NEST_BODY_KEYS.has(key) && !isNestErrorLabel) {
      extensions[key] = value;
    }
  }
  const message = body.message;
  const detail = Array.isArray(message)
    ? message.map(String).join('; ')
    : typeof message === 'string'
      ? message
      : undefined;

  const problem: ProblemDetails = { ...extensions, ...baseProblem(status, detail) };
  if (exception instanceof RequestValidationException) {
    problem.code = 'validation_failed';
    problem.errors = [...exception.errors];
  }
  // e.g. the global ThrottlerGuard's ThrottlerException (it sets Retry-After itself).
  if (status === Number(HttpStatus.TOO_MANY_REQUESTS) && problem.code === undefined) {
    problem.code = ErrorCode.RateLimited;
  }
  return problem;
}

/**
 * Client errors raised by the body parsers before any handler runs (`http-errors` with
 * `expose: true`, e.g. `entity.too.large` -> 413, `encoding.unsupported` -> 415). Their message
 * is meant for the client; everything else stays a 500.
 */
function bodyParserClientError(error: unknown): { status: number; message: string } | undefined {
  if (!(error instanceof Error) || !isRecord(error)) return undefined;
  const { status, expose, type } = error as Record<string, unknown>;
  if (expose !== true || typeof type !== 'string') return undefined;
  if (typeof status !== 'number' || status < 400 || status > 499) return undefined;
  return { status, message: error.message };
}

/** Per-route limits (login, signup, ...). The filter adds the Retry-After header. */
function fromRateLimited(error: RateLimitedError): ProblemDetails {
  return { ...baseProblem(HttpStatus.TOO_MANY_REQUESTS, error.message), code: error.code };
}

function fromUnknown(error: unknown, options: ProblemMappingOptions): ProblemDetails {
  const problem = baseProblem(HttpStatus.INTERNAL_SERVER_ERROR, 'An unexpected error occurred.');
  if (options.exposeInternals && error instanceof Error) {
    problem.debug = { name: error.name, message: error.message, stack: error.stack };
  }
  return problem;
}

/**
 * Maps anything thrown by a request handler to an RFC 7807 body.
 * Order matters: domain errors first (most specific), unknown errors last.
 */
export function toProblemDetails(
  exception: unknown,
  options: ProblemMappingOptions,
): ProblemDetails {
  if (exception instanceof DomainError) return fromDomainError(exception);
  if (exception instanceof DependencyUnavailableError) return fromDependencyUnavailable();
  if (exception instanceof RateLimitedError) return fromRateLimited(exception);
  if (exception instanceof HttpException) return fromHttpException(exception);
  if (exception instanceof ZodError) return fromZodError(exception);
  const bodyError = bodyParserClientError(exception);
  if (bodyError !== undefined) return baseProblem(bodyError.status, bodyError.message);
  return fromUnknown(exception, options);
}
