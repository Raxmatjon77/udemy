import type { EventDefinition, EventPayloadInput } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Learning events through the transactional outbox (design §7): written in the caller's
 * transaction, so they commit with the completion or not at all. The `learning.progress` topic
 * is keyed by **userId** (a learner's completions stay ordered on one partition).
 */
export abstract class LearningEventPublisher {
  abstract publish<TDef extends EventDefinition>(
    trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly userId: string },
  ): Promise<void>;
}
