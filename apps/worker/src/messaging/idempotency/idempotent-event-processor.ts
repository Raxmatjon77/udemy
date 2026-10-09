import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@udemy/contracts';
import { type DB, type Transaction, withTransaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { RegisteredEventHandler } from '../event-handler.interface';

export type ProcessingOutcome = 'processed' | 'duplicate';

/**
 * Records (consumer, eventId) in outbox.processed_events. Returns false if that row
 * already exists, i.e. this consumer has handled the event before.
 * If another replica is handling the same event right now, the INSERT waits on the
 * primary key until that transaction ends, then conflicts. No double processing.
 */
export async function claimEvent(
  trx: Transaction<DB>,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const inserted = await trx
    .insertInto('outbox.processedEvents')
    .values({ consumer, eventId })
    .onConflict((oc) => oc.columns(['consumer', 'eventId']).doNothing())
    .returning('eventId')
    .executeTakeFirst();
  return inserted !== undefined;
}

/**
 * Exactly-once *effects* on top of Kafka's at-least-once delivery: the claim row and the
 * handler's writes share ONE transaction. Handler fails -> both roll back -> a retry or a
 * redelivery can claim the event again. Handler succeeds -> both commit -> redeliveries
 * are skipped as duplicates.
 */
@Injectable()
export class IdempotentEventProcessor {
  constructor(@InjectDatabase() private readonly db: Database) {}

  process(registered: RegisteredEventHandler, envelope: EventEnvelope): Promise<ProcessingOutcome> {
    return withTransaction(this.db, async (trx) => {
      const claimed = await claimEvent(trx, registered.consumerName, envelope.eventId);
      if (!claimed) return 'duplicate';
      await registered.handler.handle(envelope, trx);
      return 'processed';
    });
  }
}
