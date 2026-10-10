import { Injectable } from '@nestjs/common';
import {
  MediaFailed,
  type MediaFailedPayload,
  MediaUploaded,
  type MediaUploadedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { MediaEventPublisher } from '../application/ports/media-event.publisher';

/** `media.asset` events through the transactional outbox; key = assetId. */
@Injectable()
export class OutboxMediaEventPublisher extends MediaEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async uploaded(trx: Transaction<DB>, payload: MediaUploadedPayload): Promise<void> {
    await this.outbox.publish(trx, MediaUploaded, payload.assetId, payload);
  }

  async failed(trx: Transaction<DB>, payload: MediaFailedPayload): Promise<void> {
    await this.outbox.publish(trx, MediaFailed, payload.assetId, payload);
  }
}
