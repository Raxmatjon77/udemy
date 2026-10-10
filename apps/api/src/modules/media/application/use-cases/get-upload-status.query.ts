import { Injectable } from '@nestjs/common';
import type { UploadStatus } from '@udemy/contracts';
import { MediaAssetNotFound } from '../../domain/media.errors';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { MediaObjectStore } from '../ports/media-object.store';

/**
 * `GetUploadStatus` (design §5): the plan plus the parts S3 already has (`ListParts`), so an
 * interrupted upload can resume. Empty once the asset left UPLOADING. The route's policy
 * (`media_asset:read`, own|any) decides who may ask; the use case only answers 404.
 */
@Injectable()
export class GetUploadStatusQuery {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
  ) {}

  async execute(assetId: string): Promise<UploadStatus> {
    const asset = await this.assets.findById(assetId);
    if (asset === null) throw new MediaAssetNotFound();
    let uploadedParts: UploadStatus['uploadedParts'] = [];
    if (asset.status === 'UPLOADING' && asset.s3UploadId !== null) {
      const parts = await this.storage.listSourceParts(asset.sourceKey, asset.s3UploadId);
      uploadedParts = (parts ?? []).map((p) => ({ partNumber: p.partNumber, size: p.size }));
    }
    return {
      assetId: asset.id,
      status: asset.status,
      partSize: asset.partSizeBytes,
      partCount: asset.partCount,
      uploadedParts,
    };
  }
}
