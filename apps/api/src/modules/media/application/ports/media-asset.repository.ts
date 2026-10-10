import type { DB, Executor, Transaction } from '@udemy/db';
import type { MediaAssetStatus, MediaFailureCode, MediaPurpose } from '../../domain/media-asset';
import type { OwnerUsage } from '../../domain/upload-quota';

/** A `media.assets` row as the use cases see it, with its transcode progress and renditions. */
export interface MediaAssetRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: MediaPurpose;
  readonly status: MediaAssetStatus;
  readonly originalFilename: string;
  readonly declaredContentType: string;
  readonly declaredSizeBytes: number;
  readonly partSizeBytes: number;
  readonly partCount: number;
  /** `uploads/{ownerId}/{id}/source` in the uploads bucket. */
  readonly sourceKey: string;
  /** Present iff UPLOADING. */
  readonly s3UploadId: string | null;
  /** `assets/{id}/a{n}/` in the media bucket; present iff READY. */
  readonly outputPrefix: string | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly failureCode: MediaFailureCode | null;
  readonly purged: boolean;
  readonly createdAt: Date;
  /** `created_at` as exact UTC text with microseconds (keyset cursors, design §14). */
  readonly createdAtText: string;
  /** `transcode_jobs.progress_pct` (null without a job). */
  readonly progressPct: number | null;
  /** Rendition names, sorted. */
  readonly renditions: readonly string[];
}

/** A `media.asset_renditions` row. */
export interface RenditionRecord {
  readonly name: string;
  readonly kind: 'HLS_VARIANT' | 'IMAGE' | 'SPRITE';
  readonly width: number;
  readonly height: number;
  readonly bandwidthBps: number | null;
  readonly codecs: string | null;
  readonly objectKey: string;
}

/** Keyset of the asset listing: `(created_at DESC, id DESC)`, exact timestamp text. */
export interface AssetKeyset {
  readonly createdAt: string;
  readonly id: string;
}

export interface NewUploadingAsset {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: MediaPurpose;
  readonly originalFilename: string;
  readonly declaredContentType: string;
  readonly declaredSizeBytes: number;
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly sourceKey: string;
  readonly s3UploadId: string;
}

/**
 * Persistence of `media.assets`. Status writes are conditional UPDATEs (the DB trigger
 * `assets_status_transition_ck` guards the edges); a `null` result means "the row was not in
 * the expected state", which the use case re-reads and decides on.
 */
export abstract class MediaAssetRepository {
  abstract findById(id: string, ex?: Executor): Promise<MediaAssetRecord | null>;
  /** Existing assets among `ids` (any order; missing ids are absent). */
  abstract findByIds(ids: readonly string[], ex?: Executor): Promise<MediaAssetRecord[]>;
  /** The owner of a non-purged asset (ownership resolver), else null. */
  abstract findLiveOwnerId(id: string): Promise<string | null>;
  /** One page `(created_at DESC, id DESC)`, optionally of one owner; returns up to `limit` rows. */
  abstract listPage(query: {
    readonly ownerId: string | null;
    readonly after: AssetKeyset | null;
    readonly limit: number;
  }): Promise<MediaAssetRecord[]>;
  abstract findRenditions(assetId: string, ex?: Executor): Promise<RenditionRecord[]>;

  /** Takes the per-owner quota advisory lock (until COMMIT) and reads the owner's usage. */
  abstract lockOwnerUsage(trx: Transaction<DB>, ownerId: string): Promise<OwnerUsage>;
  abstract insertUploading(trx: Transaction<DB>, asset: NewUploadingAsset): Promise<void>;
  /** UPLOADING -> UPLOADED (`s3_upload_id` cleared). Returns `uploaded_at`, or null if not UPLOADING. */
  abstract markUploaded(trx: Transaction<DB>, id: string): Promise<Date | null>;
  /** UPLOADING -> FAILED with `failureCode`. Returns `failed_at`, or null if not UPLOADING. */
  abstract markUploadFailed(
    trx: Transaction<DB>,
    id: string,
    failureCode: MediaFailureCode,
  ): Promise<Date | null>;
  /** UPLOADING -> ABORTED. Returns the former `s3_upload_id`, or null if not UPLOADING. */
  abstract markAborted(trx: Transaction<DB>, id: string): Promise<string | null>;
}
