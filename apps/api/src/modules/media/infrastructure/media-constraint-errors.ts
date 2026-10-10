import {
  InvalidMediaField,
  MediaAssetNotFound,
  MediaAssetUnusable,
  MediaPurposeMismatch,
  UploadNotInProgress,
} from '../domain/media.errors';

interface PgErrorLike {
  code: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

type ToDomainError = (cause: unknown) => Error;

/**
 * Constraint name -> domain error for the `media` tables (schema doc §9; for unique indexes and
 * trigger pseudo-constraints `err.constraint` is the name below). Everything else stays a 500:
 * `asset_usages_consumer_working_uq` (wrong attach order), `assets_part_count_ck`,
 * `assets_source_key_ck`, `assets_s3_upload_id_uq`, `*_immutable_ck`, 42501 from the append-only
 * guards and the transcoder-internal `transcode_*` / `asset_renditions_*` constraints are
 * programming errors, logged by the global filter.
 */
export const MEDIA_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // Already attached to another lecture / course (one working-copy consumer per asset).
  asset_usages_asset_id_working_uq: (cause) =>
    new MediaAssetUnusable({ cause, reason: 'The media asset is already in use elsewhere.' }),
  // Purged, FAILED/ABORTED, or a revision pin of a non-READY asset (usage BEFORE INSERT trigger).
  asset_usages_asset_usable_ck: (cause) => new MediaAssetUnusable({ cause }),
  // Asset purpose does not fit the consumer type (thumbnail as lecture media, ...).
  asset_usages_purpose_ck: (cause) => new MediaPurposeMismatch({ cause }),
  // A usage of an asset that does not exist.
  asset_usages_asset_id_fk: (cause) => new MediaAssetNotFound({ cause }),
  // Illegal status edge: in the api only Complete/Abort write status, from UPLOADING.
  assets_status_transition_ck: (cause) => new UploadNotInProgress({ cause }),
  // Field shapes (the app validates first; a hit is a validation gap, still the client's input).
  assets_declared_content_type_ck: (cause) =>
    new InvalidMediaField({ path: 'contentType', message: 'Invalid content type.' }, { cause }),
  assets_declared_size_bytes_ck: (cause) =>
    new InvalidMediaField({ path: 'sizeBytes', message: 'Invalid size.' }, { cause }),
  assets_original_filename_ck: (cause) =>
    new InvalidMediaField({ path: 'filename', message: 'Invalid filename.' }, { cause }),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowMediaConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = MEDIA_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapMediaConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowMediaConstraint(error);
  }
}
