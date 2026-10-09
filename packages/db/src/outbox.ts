import type { Executor } from './transaction';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: unknown;
}

/**
 * Transactional outbox: call this with the SAME transaction that performs the
 * domain write, so the change and its event commit (or roll back) atomically.
 * Debezium then ships the row to Kafka; the app never talks to Kafka directly.
 */
export async function insertOutboxEvent(
  executor: Executor,
  event: OutboxEventInput,
): Promise<{ id: string }> {
  const row = await executor
    .insertInto('outbox.events')
    .values({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      type: event.type,
      // Stringify ourselves: pg would turn a JS array into a PG array literal.
      payload: JSON.stringify(event.payload ?? null),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}
