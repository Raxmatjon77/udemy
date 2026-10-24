import { Injectable } from '@nestjs/common';
import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { LearningEventPublisher } from '../application/ports/learning-event.publisher';

/** Learning events through the transactional outbox; `learning.progress` key = userId (§7). */
@Injectable()
export class OutboxLearningEventPublisher extends LearningEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly userId: string },
  ): Promise<void> {
    await this.outbox.publish(trx, event, payload.userId, payload);
  }
}
