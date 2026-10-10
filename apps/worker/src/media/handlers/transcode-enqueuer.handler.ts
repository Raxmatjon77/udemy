import { Logger } from '@nestjs/common';
import { type EventEnvelope, MEDIA_ASSET_AGGREGATE, MediaUploaded } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { TranscodeJobQueue } from '../persistence/transcode-job-queue';

/**
 * `MediaUploaded` -> one `media.transcode_jobs` row (design §5 EnqueueTranscode, D6).
 *
 * Idempotent twice over: the insert runs in the same transaction as the `processed_events` claim
 * (a redelivery is skipped as a duplicate), and the SQL itself is `ON CONFLICT (asset_id) DO
 * NOTHING` guarded by `status = 'UPLOADED' AND purged_at IS NULL` (a stale event for an asset
 * that moved on, or a second consumer group, inserts nothing).
 */
@EventHandler(MEDIA_ASSET_AGGREGATE, MediaUploaded.type, {
  consumerName: 'media.transcode-enqueuer',
})
export class TranscodeEnqueuerHandler implements EventHandlerContract {
  private readonly logger = new Logger(TranscodeEnqueuerHandler.name);

  constructor(private readonly jobs: TranscodeJobQueue) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(MediaUploaded, envelope);
    const created = await this.jobs.enqueue(trx, event.assetId);
    if (created) {
      this.logger.log({ assetId: event.assetId, purpose: event.purpose }, 'Transcode job queued');
    } else {
      this.logger.log(
        { assetId: event.assetId },
        'No transcode job queued (job exists, or asset no longer UPLOADED / purged)',
      );
    }
  }
}
