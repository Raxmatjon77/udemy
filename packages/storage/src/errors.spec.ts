import { DependencyUnavailableError } from '@udemy/nest-common/errors';
import { describe, expect, it } from 'vitest';
import {
  StorageAccessDeniedError,
  StorageEntityTooLargeError,
  StorageError,
  StorageInvalidRequestError,
  StorageNotFoundError,
  StoragePreconditionFailedError,
  StorageSignatureMismatchError,
  StorageUnavailableError,
  StorageUsageError,
  toStorageError,
} from './errors';

const ctx = { operation: 'headObject', bucket: 'udemy-media', key: 'assets/x' };

function sdkError(name: string, status: number | undefined, extra: object = {}): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
    ...extra,
  });
}

describe('toStorageError', () => {
  it.each([
    ['NoSuchKey', 404, StorageNotFoundError],
    ['NotFound', 404, StorageNotFoundError],
    ['NoSuchUpload', 404, StorageNotFoundError],
    ['NoSuchBucket', 404, StorageNotFoundError],
    ['PreconditionFailed', 412, StoragePreconditionFailedError],
    ['NotModified', 304, StoragePreconditionFailedError],
    ['EntityTooLarge', 400, StorageEntityTooLargeError],
    ['SignatureDoesNotMatch', 403, StorageSignatureMismatchError],
    ['AccessDenied', 403, StorageAccessDeniedError],
    ['InvalidPart', 400, StorageInvalidRequestError],
    ['EntityTooSmall', 400, StorageInvalidRequestError],
    ['ServiceUnavailable', 503, StorageUnavailableError],
    ['SlowDown', 503, StorageUnavailableError],
    ['InternalError', 500, StorageUnavailableError],
    ['Unknown', 502, StorageUnavailableError],
  ])('%s (%s) -> %s', (name, status, type) => {
    const mapped = toStorageError(sdkError(name, status), ctx);
    expect(mapped).toBeInstanceOf(type);
    expect((mapped as { s3Code?: string }).s3Code).toBe(name);
    expect((mapped as { httpStatus?: number }).httpStatus).toBe(status);
  });

  it('keeps the context and the cause, and never leaks the raw SDK error type', () => {
    const raw = sdkError('NoSuchKey', 404);
    const mapped = toStorageError(raw, ctx) as StorageNotFoundError;
    expect(mapped.code).toBe('not_found');
    expect(mapped.operation).toBe('headObject');
    expect(mapped.bucket).toBe('udemy-media');
    expect(mapped.key).toBe('assets/x');
    expect(mapped.cause).toBe(raw);
    expect(mapped.name).toBe('StorageNotFoundError');
  });

  it.each([
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' }),
    new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:9000'), { code: 'ECONNREFUSED' }),
    ]),
    Object.assign(new Error('getaddrinfo ENOTFOUND minio'), { code: 'ENOTFOUND' }),
    Object.assign(new Error('socket timeout'), { name: 'TimeoutError' }),
    new Error('wrapped', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
  ])('connection failures become DependencyUnavailableError("s3") (%s)', (raw) => {
    const mapped = toStorageError(raw, ctx);
    expect(mapped).toBeInstanceOf(StorageUnavailableError);
    expect(mapped).toBeInstanceOf(DependencyUnavailableError);
    expect((mapped as DependencyUnavailableError).dependency).toBe('s3');
  });

  it('maps anything else to a StorageError("unknown") and passes typed errors through', () => {
    expect(toStorageError(new Error('weird'), ctx)).toBeInstanceOf(StorageError);
    expect((toStorageError('string', ctx) as StorageError).code).toBe('unknown');
    const usage = new StorageUsageError('bug');
    expect(toStorageError(usage, ctx)).toBe(usage);
  });
});
