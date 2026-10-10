import { DependencyUnavailableError } from '@udemy/nest-common/errors';

/**
 * Typed storage errors. Every S3 call made through `ObjectStorage` throws one of these (never a raw
 * AWS SDK error), so callers can branch with `instanceof` without knowing S3 error names.
 *
 * - `StorageError` subclasses: S3 answered and refused the request (a 4xx).
 * - `StorageUnavailableError`: S3 could not be reached, timed out or answered 5xx/503 SlowDown.
 *   It extends nest-common's `DependencyUnavailableError('s3')`, so the api's global filter maps it
 *   to `503 service_unavailable` with no extra wiring, and the transcoder can classify it as the
 *   retryable `INTERNAL` failure class.
 * - `StorageUsageError`: a programming or policy error in the caller (presigning a GET on the
 *   quarantine bucket, an invalid TTL, an unsafe prefix delete). Never retry it; fix the caller.
 * - `StorageConfigError`: invalid `StorageConfig` / `S3_*` environment.
 *
 * Messages are for logs only (they contain bucket and key names); do not send them to clients.
 */
export type StorageErrorCode =
  | 'not_found'
  | 'precondition_failed'
  | 'entity_too_large'
  | 'signature_mismatch'
  | 'access_denied'
  | 'invalid_request'
  | 'unknown';

export interface StorageErrorContext {
  /** The `ObjectStorage` operation, e.g. `completeMultipartUpload`. */
  operation: string;
  bucket?: string;
  key?: string;
}

export interface StorageErrorDetails extends StorageErrorContext {
  /** The S3 error code (`NoSuchKey`, `NoSuchUpload`, `InvalidPart`, ...), when S3 sent one. */
  s3Code?: string;
  httpStatus?: number;
  cause?: unknown;
}

export class StorageError extends Error {
  readonly operation: string;
  readonly bucket: string | undefined;
  readonly key: string | undefined;
  readonly s3Code: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    readonly code: StorageErrorCode,
    message: string,
    details: StorageErrorDetails,
  ) {
    super(message, { cause: details.cause });
    this.name = new.target.name;
    this.operation = details.operation;
    this.bucket = details.bucket;
    this.key = details.key;
    this.s3Code = details.s3Code;
    this.httpStatus = details.httpStatus;
  }
}

/**
 * The bucket, object or multipart upload does not exist. Check `s3Code` to tell them apart:
 * `NoSuchUpload` (the upload was completed or aborted), `NoSuchKey`/`NotFound` (object),
 * `NoSuchBucket`.
 */
export class StorageNotFoundError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('not_found', message, details);
  }
}

/** A conditional request failed (`If-Match`/`If-None-Match`, 412 or 304). */
export class StoragePreconditionFailedError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('precondition_failed', message, details);
  }
}

/** The object or part is larger than allowed (S3 `EntityTooLarge`, or a local size cap). */
export class StorageEntityTooLargeError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('entity_too_large', message, details);
  }
}

/** S3 rejected the signature (`SignatureDoesNotMatch`): wrong credentials or clock skew. */
export class StorageSignatureMismatchError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('signature_mismatch', message, details);
  }
}

/** The credentials are valid but not allowed to do this (per-service MinIO policies in prod). */
export class StorageAccessDeniedError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('access_denied', message, details);
  }
}

/**
 * Any other 4xx: `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` (a non-last part < 5 MiB on
 * complete), `InvalidArgument`, `MalformedXML`, ...
 */
export class StorageInvalidRequestError extends StorageError {
  constructor(message: string, details: StorageErrorDetails) {
    super('invalid_request', message, details);
  }
}

/** S3 is unreachable, timed out, or answered 5xx / `SlowDown`. Retryable. */
export class StorageUnavailableError extends DependencyUnavailableError {
  readonly operation: string;
  readonly s3Code: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(details: StorageErrorDetails) {
    super('s3', { cause: details.cause });
    this.operation = details.operation;
    this.s3Code = details.s3Code;
    this.httpStatus = details.httpStatus;
  }
}

/** The caller asked for something this package refuses to do. A bug, not a runtime condition. */
export class StorageUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid storage configuration. Thrown at startup. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const NETWORK_ERROR_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'AbortError']);

const UNAVAILABLE_S3_CODES = new Set([
  'ServiceUnavailable',
  'SlowDown',
  'InternalError',
  'XMinioServerNotInitialized',
  'XMinioStorageFull',
  'RequestTimeout',
]);

const NOT_FOUND_S3_CODES = new Set(['NoSuchKey', 'NotFound', 'NoSuchUpload', 'NoSuchBucket']);

interface SdkErrorShape {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  $fault?: unknown;
}

function asShape(error: unknown): SdkErrorShape {
  return typeof error === 'object' && error !== null ? (error as SdkErrorShape) : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** True for socket-level failures (also inside `AggregateError`, as Node's happy eyeballs throws). */
function isNetworkError(error: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => isNetworkError(inner, depth + 1));
  }
  const shape = asShape(error);
  const code = stringOrUndefined(shape.code);
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return true;
  const name = stringOrUndefined(shape.name);
  if (name !== undefined && NETWORK_ERROR_NAMES.has(name) && shape.$metadata === undefined) {
    return true;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return isNetworkError(error.cause, depth + 1);
  }
  return false;
}

/**
 * Translates whatever the AWS SDK threw into a typed storage error. Already-typed errors pass
 * through unchanged.
 */
export function toStorageError(error: unknown, context: StorageErrorContext): Error {
  if (
    error instanceof StorageError ||
    error instanceof StorageUnavailableError ||
    error instanceof StorageUsageError
  ) {
    return error;
  }
  const shape = asShape(error);
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number'
      ? shape.$metadata.httpStatusCode
      : undefined;
  const s3Code = stringOrUndefined(shape.Code) ?? stringOrUndefined(shape.name);
  const details: StorageErrorDetails = { ...context, s3Code, httpStatus: status, cause: error };

  if (status === undefined && isNetworkError(error)) {
    return new StorageUnavailableError(details);
  }
  if (
    (status !== undefined && status >= 500) ||
    (s3Code !== undefined && UNAVAILABLE_S3_CODES.has(s3Code))
  ) {
    return new StorageUnavailableError(details);
  }

  const where = describe(context);
  const what = s3Code ?? (status === undefined ? 'unknown error' : `HTTP ${status}`);
  const message = `S3 ${context.operation} failed${where}: ${what}`;

  if (status === 404 || (s3Code !== undefined && NOT_FOUND_S3_CODES.has(s3Code))) {
    return new StorageNotFoundError(message, details);
  }
  if (status === 412 || status === 304 || s3Code === 'PreconditionFailed') {
    return new StoragePreconditionFailedError(message, details);
  }
  if (s3Code === 'EntityTooLarge' || status === 413) {
    return new StorageEntityTooLargeError(message, details);
  }
  if (s3Code === 'SignatureDoesNotMatch') {
    return new StorageSignatureMismatchError(message, details);
  }
  if (status === 403 || s3Code === 'AccessDenied') {
    return new StorageAccessDeniedError(message, details);
  }
  if (status !== undefined && status >= 400) {
    return new StorageInvalidRequestError(message, details);
  }
  return new StorageError('unknown', message, details);
}

function describe(context: StorageErrorContext): string {
  if (context.bucket === undefined) return '';
  return context.key === undefined ? ` (${context.bucket})` : ` (${context.bucket}/${context.key})`;
}
