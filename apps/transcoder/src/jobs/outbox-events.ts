import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import { type DB, insertOutboxEvent, type Transaction } from '@udemy/db';

/**
 * Writes an integration event in the caller's transaction (the transcoder has no Nest
 * OutboxPublisher; design finding 11). The payload is validated against the contract first, so a
 * malformed event rolls the whole transaction back instead of reaching Kafka.
 */
export async function publishEvent<TDef extends EventDefinition>(
  trx: Transaction<DB>,
  event: TDef,
  aggregateId: string,
  payload: EventPayloadInput<TDef>,
): Promise<{ id: string }> {
  if (!trx.isTransaction) throw new Error('publishEvent must run inside a transaction');
  const parsed = event.safeParsePayload(payload);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${event.qualifiedType} payload: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return insertOutboxEvent(trx, {
    aggregateType: event.aggregateType,
    aggregateId,
    type: event.qualifiedType,
    payload: parsed.data,
  });
}
