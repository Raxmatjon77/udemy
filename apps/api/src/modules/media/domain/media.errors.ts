import { ErrorCode } from '@udemy/contracts';
import {
  ConflictError,
  type DomainFieldIssue,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@udemy/nest-common/errors';
import { RateLimitedError } from '../../../shared/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/* ----------------------------------------------------------------------------------------
 * Assets
 * -------------------------------------------------------------------------------------- */

/** 404 `media_asset_not_found`: unknown, purged-for-ownership or another user's asset (never 403). */
export class MediaAssetNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The media asset does not exist.', {
      code: ErrorCode.MediaAssetNotFound,
      cause: options.cause,
    });
  }
}

/** 422 `media_purpose_mismatch`: e.g. a thumbnail asset attached as a lecture video. */
export class MediaPurposeMismatch extends ValidationError {
  constructor(options: CauseOption & { expected?: string; actual?: string } = {}) {
    super(
      options.expected === undefined
        ? 'The media asset cannot be used here.'
        : `The media asset is not a ${options.expected} asset.`,
      { code: ErrorCode.MediaPurposeMismatch, cause: options.cause },
    );
  }
}

/** 409 `media_asset_unusable`: FAILED/ABORTED/purged, not READY for a pin, or already attached. */
export class MediaAssetUnusable extends ConflictError {
  constructor(options: CauseOption & { reason?: string } = {}) {
    super(options.reason ?? 'The media asset cannot be used.', {
      code: ErrorCode.MediaAssetUnusable,
      cause: options.cause,
    });
  }
}

/** 409 `media_not_ready`: playback, images or downloads of an asset that is not READY. */
export class MediaNotReady extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The media is not ready yet.', { code: ErrorCode.MediaNotReady, cause: options.cause });
  }
}

/** 404 `not_found`: a rendition or image variant the asset does not have. */
export class RenditionNotFound extends NotFoundError {
  constructor() {
    super('The requested rendition does not exist.', { code: ErrorCode.NotFound });
  }
}

/** 403 `forbidden`: neither `media_asset:read:own` nor `media_asset:read:any`. */
export class MediaReadForbidden extends ForbiddenError {
  constructor() {
    super('You are not allowed to list media assets.', { code: ErrorCode.Forbidden });
  }
}

/* ----------------------------------------------------------------------------------------
 * Uploads
 * -------------------------------------------------------------------------------------- */

/** 422 `unsupported_media_type`: the declared type is not allowed for the purpose. */
export class UnsupportedMediaType extends ValidationError {
  constructor(purpose: string) {
    super(`This file type is not allowed for ${purpose}.`, {
      code: ErrorCode.UnsupportedMediaType,
      issues: [{ path: 'contentType', message: 'Unsupported media type for this purpose.' }],
    });
  }
}

/** 422 `upload_too_large`: the declared size exceeds the purpose limit. */
export class UploadTooLarge extends ValidationError {
  constructor(maxBytes: number) {
    super(`The file is too large (maximum ${maxBytes} bytes).`, {
      code: ErrorCode.UploadTooLarge,
      issues: [{ path: 'sizeBytes', message: `Must be at most ${maxBytes} bytes.` }],
    });
  }
}

/** 422 `quota_exceeded`: the owner's live assets plus this upload exceed the storage quota. */
export class QuotaExceeded extends ValidationError {
  constructor() {
    super('Your media storage quota is exhausted. Delete unused media and try again.', {
      code: ErrorCode.QuotaExceeded,
    });
  }
}

/** Seconds a client should wait before retrying after `too_many_uploads`. */
export const TOO_MANY_UPLOADS_RETRY_MS = 60_000;

/** 429 `too_many_uploads`: the owner already has MEDIA_MAX_CONCURRENT_UPLOADS uploads running. */
export class TooManyUploads extends RateLimitedError {
  constructor() {
    super('Too many uploads in progress. Finish or cancel one first.', {
      code: ErrorCode.TooManyUploads,
      retryAfterMs: TOO_MANY_UPLOADS_RETRY_MS,
    });
  }
}

/** 409 `upload_not_in_progress`: the asset is no longer (or never was) UPLOADING. */
export class UploadNotInProgress extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The upload is not in progress.', {
      code: ErrorCode.UploadNotInProgress,
      cause: options.cause,
    });
  }
}

/** 409 `upload_incomplete`: S3 does not have every planned part yet (`missingParts`). */
export class UploadIncomplete extends ConflictError {
  constructor(readonly missingParts: readonly number[]) {
    super(`The upload is missing ${missingParts.length} part(s).`, {
      code: ErrorCode.UploadIncomplete,
    });
  }
}

/** 422 `upload_size_mismatch`: parts or the object differ from the declared size (asset FAILED). */
export class UploadSizeMismatch extends ValidationError {
  constructor() {
    super('The uploaded file does not match the announced size. Please upload it again.', {
      code: ErrorCode.UploadSizeMismatch,
    });
  }
}

/** 422 `validation_failed` for one field of an upload request (domain rules). */
export class InvalidMediaField extends ValidationError {
  constructor(issue: DomainFieldIssue, options: CauseOption = {}) {
    super(issue.message, {
      code: ErrorCode.ValidationFailed,
      issues: [issue],
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Internal (500): never caused by the client
 * -------------------------------------------------------------------------------------- */

/**
 * A stored variant playlist we refuse to serve: not HLS, a URI that is not a plain relative path
 * below the playlist (traversal, absolute URL), or tags this rewriter cannot sign (`URI=`).
 * Our transcoder never writes such a playlist, so this means tampering or a bug.
 */
export class PlaylistRejected extends Error {
  constructor(reason: string, options: CauseOption = {}) {
    super(`Variant playlist rejected: ${reason}`, { cause: options.cause });
    this.name = new.target.name;
  }
}
