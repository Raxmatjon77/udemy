import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import { type DB, insertOutboxEvent, type Transaction } from '@udemy/db';
import { NonRetryableError } from '../../messaging/non-retryable.error';

/**
 * Writes an integration event to the transactional outbox from a worker handler (the api's
 * `OutboxPublisher` for the worker): validated against the contract, inserted in the handler's
 * claim transaction, so the event commits exactly when the handler's writes do. A payload that
 * breaks the contract is a bug in this code: non-retryable (DLQ).
 */
export async function publishEvent<TDef extends EventDefinition>(
  trx: Transaction<DB>,
  event: TDef,
  aggregateId: string,
  payload: EventPayloadInput<TDef>,
): Promise<{ id: string }> {
  const parsed = event.safeParsePayload(payload);
  if (!parsed.success) {
    throw new NonRetryableError(`Invalid ${event.qualifiedType} payload: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return insertOutboxEvent(trx, {
    aggregateType: event.aggregateType,
    aggregateId,
    type: event.qualifiedType,
    payload: parsed.data,
  });
}
