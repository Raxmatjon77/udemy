import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/** Register for every event type on a topic (debug/audit consumers). */
export const ANY_EVENT_TYPE = '*';

/**
 * A consumer of one event type. `handle` runs inside the same transaction that marks the
 * event as processed: write your side effects with `trx` and they commit exactly once.
 * Throwing rolls everything back and triggers a retry (or the DLQ when retries run out).
 */
export interface EventHandlerContract {
  handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void>;
}

export interface EventHandlerMetadata {
  topic: string;
  /** Logical event type without version (`SystemPing`), or ANY_EVENT_TYPE. */
  eventType: string;
  /** Idempotency key in outbox.processed_events. Defaults to the class name. */
  consumerName?: string;
}

export interface RegisteredEventHandler {
  topic: string;
  eventType: string;
  consumerName: string;
  handler: EventHandlerContract;
}

export function isEventHandler(value: unknown): value is EventHandlerContract {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<EventHandlerContract>).handle === 'function'
  );
}
