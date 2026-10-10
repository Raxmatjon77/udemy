import { Injectable, Logger } from '@nestjs/common';
import type { AssetView } from '@udemy/contracts';
import { completionStep } from '../../domain/media-asset';
import {
  MediaAssetNotFound,
  UploadIncomplete,
  UploadNotInProgress,
  UploadSizeMismatch,
} from '../../domain/media.errors';
import { judgeUploadedParts, planOf } from '../../domain/upload-plan';
import { loadOwnedAsset } from '../owned-asset';
import { MediaEventPublisher } from '../ports/media-event.publisher';
import { type MediaAssetRecord, MediaAssetRepository } from '../ports/media-asset.repository';
import { MediaObjectStore } from '../ports/media-object.store';
import { TransactionRunner } from '../ports/transaction-runner';
import { toAssetView } from '../views';

export interface CompleteUploadInput {
  readonly ownerId: string;
  readonly assetId: string;
}

/**
 * `CompleteUpload` (design §5, D10). Never trusts the client: the request has no body.
 *
 * 1. Server-side `ListParts`, checked against the stored plan (`checkUploadedParts`):
 *    missing parts -> 409 `upload_incomplete` + `missingParts` (retryable); a wrong size or a
 *    part outside the plan -> the asset becomes FAILED (`UPLOAD_SIZE_MISMATCH`, outbox
 *    `MediaFailed`), the upload is aborted and 422 `upload_size_mismatch`.
 * 2. `CompleteMultipartUpload` with the LISTED parts, then `HeadObject`: the object size must
 *    equal the declared size (else FAILED as above, object deleted).
 * 3. One transaction: UPLOADING -> UPLOADED (`s3_upload_id` cleared) + outbox `MediaUploaded`.
 *
 * Idempotent: an asset already past UPLOADING answers its current state. If S3 no longer knows
 * the upload but holds a correct object (an earlier complete died between S3 and the DB, or a
 * concurrent complete won), the DB step is finished. Complete-vs-janitor race (schema doc §6
 * item 11): if the conditional UPDATE finds the asset ABORTED, the object just completed is
 * deleted and 409 `upload_not_in_progress` is returned.
 */
@Injectable()
export class CompleteUploadCommand {
  private readonly logger = new Logger(CompleteUploadCommand.name);

  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaObjectStore,
    private readonly events: MediaEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CompleteUploadInput): Promise<AssetView> {
    const asset = await loadOwnedAsset(this.assets, input.assetId, input.ownerId);
    const step = completionStep(asset.status);
    if (step === 'already-done') return toAssetView(asset);
    if (step === 'not-in-progress' || asset.s3UploadId === null) throw new UploadNotInProgress();

    const uploadId = asset.s3UploadId;
    const plan = planOf(asset);
    const parts = await this.storage.listSourceParts(asset.sourceKey, uploadId);
    if (parts !== null) {
      const verdict = judgeUploadedParts(plan, parts);
      if (verdict.kind === 'incomplete') throw new UploadIncomplete(verdict.missingParts);
      if (verdict.kind === 'size-mismatch') {
        this.logger.warn(
          {
            assetId: asset.id,
            wrongSize: verdict.check.wrongSize.length,
            unexpected: verdict.check.unexpected.length,
          },
          'Upload parts do not match the plan',
        );
        return this.failSizeMismatch(asset, uploadId);
      }
      // `false`: NoSuchUpload, a concurrent complete (or the janitor) got there first.
      await this.storage.completeSourceUpload({
        sourceKey: asset.sourceKey,
        uploadId,
        parts,
        plan,
      });
    }
    return this.finishFromObject(asset);
  }

  /** Step 2 + 3, once S3 holds (or should hold) the completed object. */
  private async finishFromObject(asset: MediaAssetRecord): Promise<AssetView> {
    const size = await this.storage.sourceSize(asset.sourceKey);
    if (size === null) return this.settle(asset.id, false);
    if (size !== asset.declaredSizeBytes) {
      this.logger.warn(
        { assetId: asset.id },
        'Completed object size differs from the declared size',
      );
      return this.failSizeMismatch(asset, null);
    }

    const uploadedAt = await this.tx.run(async (trx) => {
      const at = await this.assets.markUploaded(trx, asset.id);
      if (at === null) return null;
      await this.events.uploaded(trx, {
        assetId: asset.id,
        ownerId: asset.ownerId,
        purpose: asset.purpose,
        declaredContentType: asset.declaredContentType,
        sizeBytes: asset.declaredSizeBytes,
        uploadedAt: at.toISOString(),
      });
      return at;
    });
    if (uploadedAt === null) return this.settle(asset.id, true);
    return this.currentView(asset.id);
  }

  /**
   * The conditional UPDATE did not apply (or S3 has neither the upload nor the object): decide
   * from the current row. `objectCompleted`: S3 holds the object we just completed.
   */
  private async settle(assetId: string, objectCompleted: boolean): Promise<AssetView> {
    const current = await this.assets.findById(assetId);
    if (current === null) throw new MediaAssetNotFound();
    const step = completionStep(current.status);
    if (step === 'already-done') return toAssetView(current);
    if (step === 'not-in-progress' && objectCompleted) {
      // The janitor aborted the asset while we completed in S3: the object is an orphan.
      await this.deleteSourceQuietly(current.sourceKey);
    }
    // Still UPLOADING without upload or object in S3 (lost upload): the janitor aborts it.
    throw new UploadNotInProgress();
  }

  /** UPLOADING -> FAILED (UPLOAD_SIZE_MISMATCH) + `MediaFailed`, then drop the bytes; always 422. */
  private async failSizeMismatch(asset: MediaAssetRecord, uploadId: string | null): Promise<never> {
    await this.tx.run(async (trx) => {
      const failedAt = await this.assets.markUploadFailed(trx, asset.id, 'UPLOAD_SIZE_MISMATCH');
      if (failedAt === null) return;
      await this.events.failed(trx, {
        assetId: asset.id,
        ownerId: asset.ownerId,
        purpose: asset.purpose,
        failureCode: 'UPLOAD_SIZE_MISMATCH',
        attempts: 0,
        failedAt: failedAt.toISOString(),
      });
    });
    try {
      if (uploadId !== null) await this.storage.abortSourceUpload(asset.sourceKey, uploadId);
      await this.storage.deleteSource(asset.sourceKey);
    } catch (error) {
      // The janitor deletes FAILED sources (cleanup D') and stale multipart uploads (B).
      this.logger.warn({ err: error, assetId: asset.id }, 'Could not delete a mismatched upload');
    }
    throw new UploadSizeMismatch();
  }

  private async currentView(assetId: string): Promise<AssetView> {
    const current = await this.assets.findById(assetId);
    if (current === null) throw new MediaAssetNotFound();
    return toAssetView(current);
  }

  private async deleteSourceQuietly(sourceKey: string): Promise<void> {
    try {
      await this.storage.deleteSource(sourceKey);
    } catch (error) {
      // Backstop: purging the ABORTED asset deletes its whole uploads/{owner}/{asset}/ prefix.
      this.logger.warn({ err: error }, 'Could not delete the orphaned completed upload');
    }
  }
}
