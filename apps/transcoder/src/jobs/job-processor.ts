import { Inject, Injectable, Logger } from '@nestjs/common';
import { MediaFailed, type MediaPurpose, MediaPurposeSchema, MediaReady } from '@udemy/contracts';
import {
  completeTranscodeJob,
  failTranscodeJob,
  type FailResult,
  type LeaseFence,
  type LeaseResult,
  releaseTranscodeJob,
  TranscodeLeaseLostError,
  transcodeOutputPrefix,
  withTransaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { assetOutputPrefix, ObjectStorage } from '@udemy/storage';
import {
  classifyFailure,
  type FailureCode,
  isRetryable,
  TranscodeFailure,
} from '../pipeline/failure';
import { MediaPipeline } from '../pipeline/media-pipeline';
import { createWorkDir, removeWorkDir } from '../pipeline/source';
import { LeaseLostAbort, ShutdownAbort } from './abort-reasons';
import { JOB_SETTINGS, type JobSettings } from './job-settings';
import { LeaseHeartbeat } from './lease-heartbeat';
import { publishEvent } from './outbox-events';
import { deleteFailedSources } from './source-cleanup';

export type LeasedJob = Extract<LeaseResult, { kind: 'leased' }>;

export type JobOutcome =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'retry'; readonly code: FailureCode; readonly runAfter: Date }
  | { readonly kind: 'failed'; readonly code: FailureCode }
  /** Graceful shutdown: requeued without penalty. */
  | { readonly kind: 'released' }
  /** Fenced out: another lease owns the job now; nothing was written. */
  | { readonly kind: 'lease_lost' }
  /** The failure could not be recorded (DB down); the lease expires and the reaper takes over. */
  | { readonly kind: 'unrecorded' };

/**
 * Runs ONE leased job: heartbeat, pipeline, then either COMPLETE (+ MediaReady) or FAIL
 * (+ MediaFailed when terminal) in one transaction each. Always wipes the work dir.
 */
@Injectable()
export class JobProcessor {
  private readonly logger = new Logger(JobProcessor.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly pipeline: MediaPipeline,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(JOB_SETTINGS) private readonly settings: JobSettings,
  ) {}

  async run(job: LeasedJob, shutdown: AbortSignal): Promise<JobOutcome> {
    const fence: LeaseFence = {
      assetId: job.assetId,
      workerId: this.settings.workerId,
      leaseNo: job.leaseNo,
    };
    const context = { assetId: job.assetId, leaseNo: job.leaseNo, attempts: job.attempts };
    const controller = new AbortController();
    const onShutdown = (): void => controller.abort(new ShutdownAbort());
    if (shutdown.aborted) onShutdown();
    else shutdown.addEventListener('abort', onShutdown, { once: true });

    const heartbeat = new LeaseHeartbeat({
      db: this.db,
      fence,
      leaseMs: this.settings.leaseMs,
      intervalMs: this.settings.heartbeatIntervalMs,
      onLost: (reason) => controller.abort(new LeaseLostAbort(reason)),
      logger: this.logger,
    });
    heartbeat.start();
    this.logger.log({ ...context, purpose: job.asset.purpose }, 'Transcode job started');

    let workDir: string | undefined;
    try {
      const purpose = parsePurpose(job.asset.purpose);
      workDir = await createWorkDir(this.settings.tmpDir, job.assetId, job.leaseNo);
      const result = await this.pipeline.process({
        assetId: job.assetId,
        leaseNo: job.leaseNo,
        purpose,
        sourceKey: job.asset.sourceKey,
        declaredSizeBytes: Number(job.asset.declaredSizeBytes),
        workDir,
        signal: controller.signal,
        reportProgress: (pct) => heartbeat.report(pct),
      });
      await heartbeat.stop();
      // Shutdown after the work is done does not matter: completing is cheaper than redoing.
      // A lost lease does: complete is fenced and would throw TranscodeLeaseLostError anyway.
      if (controller.signal.reason instanceof LeaseLostAbort) throw controller.signal.reason;

      await withTransaction(this.db, async (trx) => {
        const asset = await completeTranscodeJob(trx, { ...fence, ...result });
        await publishEvent(trx, MediaReady, job.assetId, {
          assetId: job.assetId,
          ownerId: asset.ownerId,
          purpose,
          durationMs: asset.durationMs,
          width: asset.width,
          height: asset.height,
          renditions: result.renditions.map((r) => r.name),
          readyAt: asset.readyAt.toISOString(),
        });
      });
      this.logger.log(
        { ...context, renditions: result.renditions.map((r) => r.name) },
        'Transcode job succeeded',
      );
      return { kind: 'succeeded' };
    } catch (error) {
      await heartbeat.stop();
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      return await this.handleFailure(job, fence, reason);
    } finally {
      shutdown.removeEventListener('abort', onShutdown);
      if (workDir !== undefined) {
        await removeWorkDir(workDir).catch((err: unknown) =>
          this.logger.warn({ err, ...context }, 'Could not remove the work dir'),
        );
      }
    }
  }

  private async handleFailure(
    job: LeasedJob,
    fence: LeaseFence,
    reason: unknown,
  ): Promise<JobOutcome> {
    const context = { assetId: job.assetId, leaseNo: job.leaseNo, attempts: job.attempts };

    if (reason instanceof ShutdownAbort) {
      const released = await releaseTranscodeJob(this.db, fence).catch((err: unknown) => {
        this.logger.warn({ err, ...context }, 'Could not release the lease on shutdown');
        return false;
      });
      await this.discardOutputs(job);
      this.logger.log({ ...context, released }, 'Transcode job released (shutdown)');
      return { kind: 'released' };
    }
    if (reason instanceof LeaseLostAbort || reason instanceof TranscodeLeaseLostError) {
      await this.discardOutputs(job);
      this.logger.warn(
        { ...context, reason: reason.message },
        'Transcode lease lost; work discarded',
      );
      return { kind: 'lease_lost' };
    }

    const failure = classifyFailure(reason);
    const retryable = isRetryable(
      failure,
      job.attempts,
      Math.min(job.maxAttempts, this.settings.maxAttempts),
    );
    let result: FailResult;
    try {
      result = await withTransaction(this.db, async (trx) => {
        const failed = await failTranscodeJob(trx, {
          ...fence,
          code: failure.code,
          detail: failure.detail,
          retryable,
        });
        if (failed.outcome === 'FAILED' && failed.asset !== null) {
          await publishEvent(trx, MediaFailed, job.assetId, {
            assetId: job.assetId,
            ownerId: failed.asset.ownerId,
            purpose: parsePurpose(failed.asset.purpose),
            failureCode: failure.code,
            attempts: failed.attempts,
            failedAt: new Date().toISOString(),
          });
        }
        return failed;
      });
    } catch (error) {
      await this.discardOutputs(job);
      if (error instanceof TranscodeLeaseLostError) {
        this.logger.warn({ ...context, code: failure.code }, 'Transcode lease lost while failing');
        return { kind: 'lease_lost' };
      }
      this.logger.error(
        { err: error, ...context, code: failure.code },
        'Could not record the failure',
      );
      return { kind: 'unrecorded' };
    }

    await this.discardOutputs(job);
    if (result.outcome === 'RETRY') {
      this.logger.warn(
        { ...context, code: failure.code, detail: failure.detail, runAfter: result.runAfter },
        'Transcode job failed; retry scheduled',
      );
      return { kind: 'retry', code: failure.code, runAfter: result.runAfter };
    }
    this.logger.warn(
      { ...context, code: failure.code, detail: failure.detail },
      'Transcode job failed terminally',
    );
    if (result.asset !== null) {
      await deleteFailedSources(
        this.db,
        this.storage,
        [{ assetId: job.assetId, sourceKey: result.asset.sourceKey }],
        this.logger,
      );
    }
    return { kind: 'failed', code: failure.code };
  }

  /**
   * Deletes this attempt's (partial) outputs under `assets/{id}/a{n}/`. Skipped when the asset is
   * READY with exactly this prefix (a COMMIT whose acknowledgement was lost) or when that cannot be
   * checked: an orphan is harmless (purge deletes `assets/{id}/`), a deleted live output is not.
   */
  private async discardOutputs(job: LeasedJob): Promise<void> {
    const prefix = assetOutputPrefix(job.assetId, job.leaseNo);
    try {
      const row = await this.db
        .selectFrom('media.assets')
        .select('outputPrefix')
        .where('id', '=', job.assetId)
        .executeTakeFirst();
      if (row?.outputPrefix === transcodeOutputPrefix(job.assetId, job.leaseNo)) return;
      await this.storage.deletePrefix({ bucket: 'media', prefix });
    } catch (error) {
      this.logger.warn({ err: error, assetId: job.assetId, prefix }, 'Could not discard outputs');
    }
  }
}

function parsePurpose(value: string): MediaPurpose {
  const parsed = MediaPurposeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TranscodeFailure('INTERNAL', `unknown asset purpose ${value}`, true);
  }
  return parsed.data;
}
