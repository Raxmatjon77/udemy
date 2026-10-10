import { Injectable } from '@nestjs/common';
import type { PresignPartsResponse } from '@udemy/contracts';
import { UploadNotInProgress } from '../../domain/media.errors';
import { assertPartNumbers, partContentLength, planOf } from '../../domain/upload-plan';
import { MediaSettings } from '../media-settings';
import { loadOwnedAsset } from '../owned-asset';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { MediaObjectStore } from '../ports/media-object.store';
import { UploadRateLimiter } from '../ports/upload-rate-limiter';

export interface PresignPartsInput {
  readonly ownerId: string;
  readonly assetId: string;
  /** 1–50 distinct numbers (request schema); each must be ≤ the asset's partCount. */
  readonly partNumbers: readonly number[];
}

/**
 * `PresignParts` (design §5, D10): one presigned UploadPart PUT per requested part, each with
 * the part's exact size signed as `Content-Length` and TTL `MEDIA_PART_URL_TTL_S`. Owner only,
 * UPLOADING only (409 `upload_not_in_progress`), part numbers within the plan (422), rate
 * limited per user (`rl:media:parts:u:{uid}`, 429). Presigning is local HMAC: no S3 round trip.
 */
@Injectable()
export class PresignPartsCommand {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
    private readonly rateLimiter: UploadRateLimiter,
    private readonly settings: MediaSettings,
  ) {}

  async execute(input: PresignPartsInput): Promise<PresignPartsResponse> {
    const asset = await loadOwnedAsset(this.assets, input.assetId, input.ownerId);
    if (asset.status !== 'UPLOADING' || asset.s3UploadId === null) throw new UploadNotInProgress();
    const plan = planOf(asset);
    assertPartNumbers(plan, input.partNumbers);
    await this.rateLimiter.hitPresignParts(input.ownerId);

    const uploadId = asset.s3UploadId;
    const ttlSeconds = this.settings.values.partUrlTtlSeconds;
    const signed = await Promise.all(
      input.partNumbers.map(async (partNumber) => ({
        partNumber,
        signed: await this.storage.presignSourcePart({
          sourceKey: asset.sourceKey,
          uploadId,
          partNumber,
          contentLength: partContentLength(plan, partNumber),
          ttlSeconds,
        }),
      })),
    );
    const expiresAt = Math.min(...signed.map((s) => s.signed.expiresAt.getTime()));
    return {
      urls: signed.map((s) => ({ partNumber: s.partNumber, url: s.signed.url })),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}
