import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Engagement events through the transactional outbox (design §7): written in the caller's
 * transaction, so they commit with the review / reply / report write or not at all. Every
 * engagement topic is keyed by **courseId** (the rating aggregator recomputes per course, D11),
 * so the aggregate id is always `payload.courseId`.
 */
export abstract class EngagementEventPublisher {
  abstract publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly courseId: string },
  ): Promise<void>;
}
