import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { InitiateUploadResponse, MediaPurpose } from '@udemy/contracts';
import { uploadSourceKey } from '@udemy/storage';
import { sanitizeFilename } from '../../domain/media-asset';
import { PurposePolicy } from '../../domain/purpose-policy';
import { planUpload } from '../../domain/upload-plan';
import { admitUpload } from '../../domain/upload-quota';
import { MediaSettings } from '../media-settings';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { MediaObjectStore } from '../ports/media-object.store';
import { TransactionRunner } from '../ports/transaction-runner';
import { UploadRateLimiter } from '../ports/upload-rate-limiter';

export interface InitiateUploadInput {
  readonly ownerId: string;
  readonly purpose: MediaPurpose;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * RFC 9562 UUIDv7 (time-ordered like Postgres' `uuidv7()`). The id is needed before the INSERT
 * because the S3 key contains it (schema doc §7).
 */
export function newAssetId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `InitiateUpload` (design §5, §9):
 *
 * 1. Purpose policy (422 `unsupported_media_type` / `upload_too_large`), filename sanitising.
 * 2. Redis rate limit `rl:media:initiate:u:{uid}` (429 `rate_limited`).
 * 3. One transaction: per-owner advisory lock + usage (`lockOwnerMediaUsage`), concurrency
 *    (429 `too_many_uploads`) and quota (422 `quota_exceeded`); S3 CreateMultipartUpload
 *    (allowlisted Content-Type, `Content-Disposition: attachment`); INSERT the UPLOADING asset
 *    with the server-chosen part plan. The S3 call sits inside the lock on purpose: a rejected
 *    request never creates a multipart upload, and two initiates of one owner cannot both pass
 *    the quota. Only that owner's initiates wait on the lock.
 * 4. If anything after CreateMultipartUpload fails (INSERT, COMMIT), the upload is aborted.
 *
 * Not deduplicated (design §8): a duplicate UPLOADING asset is aborted by the janitor.
 */
@Injectable()
export class InitiateUploadCommand {
  private readonly logger = new Logger(InitiateUploadCommand.name);
  private readonly policy: PurposePolicy;

  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
    private readonly rateLimiter: UploadRateLimiter,
    private readonly tx: TransactionRunner,
    private readonly settings: MediaSettings,
  ) {
    this.policy = new PurposePolicy(settings.values.maxBytes);
  }

  async execute(input: InitiateUploadInput): Promise<InitiateUploadResponse> {
    const accepted = this.policy.accept(input.purpose, input.contentType, input.sizeBytes);
    const filename = sanitizeFilename(input.filename);
    const plan = planUpload(accepted.sizeBytes);
    await this.rateLimiter.hitInitiate(input.ownerId);

    const assetId = newAssetId();
    const sourceKey = uploadSourceKey(input.ownerId, assetId);
    let uploadId: string | undefined;
    try {
      await this.tx.run(async (trx) => {
        const usage = await this.assets.lockOwnerUsage(trx, input.ownerId);
        admitUpload(usage, accepted.sizeBytes, this.settings.values.quota);
        uploadId = await this.storage.createSourceUpload(sourceKey, accepted.contentType);
        await this.assets.insertUploading(trx, {
          id: assetId,
          ownerId: input.ownerId,
          purpose: accepted.purpose,
          originalFilename: filename,
          declaredContentType: accepted.contentType,
          declaredSizeBytes: accepted.sizeBytes,
          partSizeBytes: plan.partSize,
          partCount: plan.partCount,
          sourceKey,
          s3UploadId: uploadId,
        });
      });
    } catch (error) {
      if (uploadId !== undefined) await this.abortQuietly(sourceKey, uploadId);
      throw error;
    }
    return { assetId, partSize: plan.partSize, partCount: plan.partCount };
  }

  /** Best effort: the janitor (step B) aborts multipart uploads that match no asset anyway. */
  private async abortQuietly(sourceKey: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortSourceUpload(sourceKey, uploadId);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not abort the multipart upload of a failed initiate');
    }
  }
}
