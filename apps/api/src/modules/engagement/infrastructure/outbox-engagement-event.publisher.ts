import { Injectable } from '@nestjs/common';
import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { EngagementEventPublisher } from '../application/ports/engagement-event.publisher';

/** Engagement events through the transactional outbox; key = courseId (design §7, D11). */
@Injectable()
export class OutboxEngagementEventPublisher extends EngagementEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly courseId: string },
  ): Promise<void> {
    await this.outbox.publish(trx, event, payload.courseId, payload);
  }
}
