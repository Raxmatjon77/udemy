import type { MediaFailedPayload, MediaUploadedPayload } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/** Port for the `media.asset` outbox events (aggregateId = assetId), in the caller's transaction. */
export abstract class MediaEventPublisher {
  /** CompleteUpload: the worker enqueues the transcode job from it (D6). */
  abstract uploaded(trx: Transaction<DB>, payload: MediaUploadedPayload): Promise<void>;
  /** CompleteUpload size mismatch (`attempts` 0): the processing-failed mailer tells the owner. */
  abstract failed(trx: Transaction<DB>, payload: MediaFailedPayload): Promise<void>;
}
