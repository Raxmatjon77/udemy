import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/** Register for every event type on a topic (debug/audit consumers). */
export const ANY_EVENT_TYPE = '*';

/** Work to run once the claim transaction has committed (see `HandlerContext.afterCommit`). */
export type AfterCommitTask = () => Promise<void> | void;

/** Per-delivery services a handler may use besides the transaction. */
export interface HandlerContext {
  /**
   * Runs `task` after the transaction that claimed the event (and holds the handler's writes)
   * COMMITTED: e.g. a realtime push or another non-transactional side effect that must never
   * announce a row that rolls back (Phase 5 design finding 7).
   *
   * - Tasks run in registration order, only when this delivery committed; a rolled-back attempt
   *   drops its tasks, and the retry registers its own.
   * - A task that throws is logged and skipped: the event is already processed, so a retry would
   *   be a duplicate and never re-run it. Use it only for effects that tolerate loss
   *   (invalidation hints), or make the effect durable with `trx` instead (e.g. a job row).
   * - Register during `handle` only; registering after it returned throws.
   */
  afterCommit(task: AfterCommitTask): void;
}

/**
 * A consumer of one event type. `handle` runs inside the same transaction that marks the
 * event as processed: write your side effects with `trx` and they commit exactly once.
 * Throwing rolls everything back and triggers a retry (or the DLQ when retries run out).
 * Effects that must wait for the commit go through `context.afterCommit`.
 */
export interface EventHandlerContract {
  handle(envelope: EventEnvelope, trx: Transaction<DB>, context: HandlerContext): Promise<void>;
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
