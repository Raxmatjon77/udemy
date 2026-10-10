import { Inject, Injectable, Logger } from '@nestjs/common';
import { MediaFailed, MediaPurposeSchema } from '@udemy/contracts';
import { reapExpiredTranscodeLeases, type ReapedLease, withTransaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';
import { publishEvent } from './outbox-events';
import { deleteFailedSources } from './source-cleanup';

export const REAPER_BATCH_SIZE = 20;

/**
 * The separate reaper (schema doc §6 item 7, §8.1): leases that expired without a heartbeat
 * (crashed/OOM-killed transcoder) are closed as LEASE_LOST/CRASHED, then requeued, or failed for
 * good once attempts are exhausted, with MediaFailed{CRASHED} in the same transaction.
 */
@Injectable()
export class LeaseReaper {
  private readonly logger = new Logger(LeaseReaper.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
  ) {}

  async reapOnce(batchSize: number = REAPER_BATCH_SIZE): Promise<ReapedLease[]> {
    const reaped = await withTransaction(this.db, async (trx) => {
      const rows = await reapExpiredTranscodeLeases(trx, { batchSize });
      const failedAt = new Date().toISOString();
      for (const row of rows) {
        if (row.outcome !== 'FAILED' || row.asset === null) continue;
        await publishEvent(trx, MediaFailed, row.assetId, {
          assetId: row.assetId,
          ownerId: row.asset.ownerId,
          purpose: MediaPurposeSchema.parse(row.asset.purpose),
          failureCode: 'CRASHED',
          attempts: row.attempts,
          failedAt,
        });
      }
      return rows;
    });

    const sources: { assetId: string; sourceKey: string }[] = [];
    for (const row of reaped) {
      this.logger.warn(
        { assetId: row.assetId, leaseNo: row.leaseNo, outcome: row.outcome },
        'Reaped an expired transcode lease',
      );
      if (row.outcome === 'FAILED' && row.asset !== null) {
        sources.push({ assetId: row.assetId, sourceKey: row.asset.sourceKey });
      }
    }
    if (sources.length > 0) {
      await deleteFailedSources(this.db, this.storage, sources, this.logger);
    }
    return reaped;
  }
}
