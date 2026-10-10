import {
  StorageEntityTooLargeError,
  StorageNotFoundError,
  StorageUnavailableError,
} from '@udemy/storage';
import { MediaNotReady, PlaylistRejected, UploadNotInProgress } from '../domain/media.errors';

/** S3 no longer knows the multipart upload (completed or aborted). */
export function isNoSuchUpload(error: unknown): boolean {
  return error instanceof StorageNotFoundError && error.s3Code === 'NoSuchUpload';
}

/**
 * `@udemy/storage` errors -> what a media caller should see:
 * - `StorageUnavailableError` (S3 down, 5xx, SlowDown): unchanged; it is a
 *   `DependencyUnavailableError`, so the global filter answers 503 `service_unavailable`.
 * - `NoSuchUpload`: 409 `upload_not_in_progress` (the janitor or a concurrent request won).
 * - A missing media object (`NoSuchKey`) behind a READY asset: 409 `media_not_ready` (e.g. the
 *   purge is deleting it); the cause is logged.
 * - An oversized playlist object: rejected like any foreign playlist (500).
 * - Everything else (`StorageAccessDeniedError`, `StorageSignatureMismatchError`,
 *   `StorageInvalidRequestError`, `StorageUsageError`, ...): unchanged, a 500 with the details
 *   in the log only (bucket and key names never reach clients).
 */
export function toMediaStorageError(error: unknown): unknown {
  if (error instanceof StorageUnavailableError) return error;
  if (isNoSuchUpload(error)) return new UploadNotInProgress({ cause: error });
  if (error instanceof StorageNotFoundError) return new MediaNotReady({ cause: error });
  if (error instanceof StorageEntityTooLargeError) {
    return new PlaylistRejected('the playlist object is too large', { cause: error });
  }
  return error;
}
