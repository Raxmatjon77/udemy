import { QuotaExceeded, TooManyUploads } from './media.errors';

export interface UploadQuotaLimits {
  /** `MEDIA_QUOTA_BYTES_PER_OWNER` */
  readonly quotaBytes: number;
  /** `MEDIA_MAX_CONCURRENT_UPLOADS` */
  readonly maxConcurrentUploads: number;
}

/** The owner's usage, read under the per-owner advisory lock (`lockOwnerMediaUsage`). */
export interface OwnerUsage {
  /** Σ declared sizes of non-purged UPLOADING/UPLOADED/PROCESSING/READY assets (int8 text). */
  readonly usedBytes: string;
  /** UPLOADING assets. */
  readonly uploading: number;
}

/**
 * Admission of one more upload of `sizeBytes` (design §4 "Quota"). Concurrency is checked
 * first: a client with five stuck uploads gets the actionable 429 rather than a quota error.
 * Byte arithmetic uses BigInt (int8 sums can exceed 2^53 in theory).
 *
 * @throws TooManyUploads (429 `too_many_uploads`)
 * @throws QuotaExceeded (422 `quota_exceeded`)
 */
export function admitUpload(usage: OwnerUsage, sizeBytes: number, limits: UploadQuotaLimits): void {
  if (usage.uploading >= limits.maxConcurrentUploads) throw new TooManyUploads();
  if (BigInt(usage.usedBytes) + BigInt(sizeBytes) > BigInt(limits.quotaBytes)) {
    throw new QuotaExceeded();
  }
}
