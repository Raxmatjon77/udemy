import { Injectable, Logger } from '@nestjs/common';
import { UploadNotInProgress } from '../../domain/media.errors';
import { loadOwnedAsset } from '../owned-asset';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { MediaObjectStore } from '../ports/media-object.store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface AbortUploadInput {
  readonly ownerId: string;
  readonly assetId: string;
}

/**
 * `AbortUpload` (design §5): UPLOADING -> ABORTED in the database first (conditional UPDATE;
 * anything else is 409 `upload_not_in_progress`), then the idempotent S3 abort. If S3 is
 * unreachable after the commit, the request still succeeds: the asset is ABORTED for good and
 * the janitor (cleanup B) aborts multipart uploads that match no UPLOADING asset.
 */
@Injectable()
export class AbortUploadCommand {
  private readonly logger = new Logger(AbortUploadCommand.name);

  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: AbortUploadInput): Promise<void> {
    const asset = await loadOwnedAsset(this.assets, input.assetId, input.ownerId);
    if (asset.status !== 'UPLOADING') throw new UploadNotInProgress();
    const uploadId = await this.tx.run((trx) => this.assets.markAborted(trx, asset.id));
    if (uploadId === null) throw new UploadNotInProgress();
    try {
      await this.storage.abortSourceUpload(asset.sourceKey, uploadId);
    } catch (error) {
      this.logger.warn({ err: error, assetId: asset.id }, 'S3 abort failed; the janitor retries');
    }
  }
}
