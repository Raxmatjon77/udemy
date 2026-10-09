import { Injectable } from '@nestjs/common';
import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import { type DB, insertOutboxEvent, type Transaction } from '@udemy/db';
import { OutboxPayloadError } from './outbox-payload.error';

/**
 * Publishes integration events through the transactional outbox.
 *
 *   await withTransaction(db, async (trx) => {
 *     await coursesRepo.publish(trx, courseId);
 *     await outbox.publish(trx, CoursePublished, courseId, { courseId, publishedAt });
 *   });
 *
 * The event row commits or rolls back together with the domain write. Debezium then
 * streams it to the Kafka topic named after the event's aggregateType.
 */
@Injectable()
export class OutboxPublisher {
  async publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    aggregateId: string,
    payload: EventPayloadInput<TDef>,
  ): Promise<{ id: string }> {
    // The type only allows a Transaction, but `Kysely` is structurally close; check at runtime too.
    if (!trx.isTransaction) {
      throw new Error('OutboxPublisher.publish must run inside the caller transaction');
    }
    const parsed = event.safeParsePayload(payload);
    if (!parsed.success) {
      throw new OutboxPayloadError(event.qualifiedType, parsed.error.issues);
    }
    return insertOutboxEvent(trx, {
      aggregateType: event.aggregateType,
      aggregateId,
      type: event.qualifiedType,
      payload: parsed.data,
    });
  }
}
