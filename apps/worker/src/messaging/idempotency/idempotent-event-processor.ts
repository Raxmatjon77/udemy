import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@udemy/contracts';
import { type DB, type Transaction, withTransaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type {
  AfterCommitTask,
  HandlerContext,
  RegisteredEventHandler,
} from '../event-handler.interface';

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

/** Collects one delivery's after-commit tasks; closed once `handle` has returned. */
class AfterCommitTasks implements HandlerContext {
  readonly tasks: AfterCommitTask[] = [];
  private open = true;

  afterCommit(task: AfterCommitTask): void {
    if (!this.open) {
      throw new Error('afterCommit must be called while the handler runs (before it returns)');
    }
    this.tasks.push(task);
  }

  close(): void {
    this.open = false;
  }
}

/**
 * Exactly-once *effects* on top of Kafka's at-least-once delivery: the claim row and the
 * handler's writes share ONE transaction. Handler fails -> both roll back -> a retry or a
 * redelivery can claim the event again. Handler succeeds -> both commit -> redeliveries
 * are skipped as duplicates.
 *
 * After-commit tasks (`HandlerContext.afterCommit`) run only once that transaction committed,
 * in registration order; their failures are logged, never rethrown (the event is processed).
 */
@Injectable()
export class IdempotentEventProcessor {
  private readonly logger = new Logger(IdempotentEventProcessor.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  async process(
    registered: RegisteredEventHandler,
    envelope: EventEnvelope,
  ): Promise<ProcessingOutcome> {
    const context = new AfterCommitTasks();
    let outcome: ProcessingOutcome;
    try {
      outcome = await withTransaction(this.db, async (trx) => {
        const claimed = await claimEvent(trx, registered.consumerName, envelope.eventId);
        if (!claimed) return 'duplicate';
        await registered.handler.handle(envelope, trx, context);
        return 'processed';
      });
    } finally {
      context.close();
    }
    if (outcome === 'processed') await this.runAfterCommit(registered, envelope, context.tasks);
    return outcome;
  }

  private async runAfterCommit(
    registered: RegisteredEventHandler,
    envelope: EventEnvelope,
    tasks: readonly AfterCommitTask[],
  ): Promise<void> {
    for (const task of tasks) {
      try {
        await task();
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            consumer: registered.consumerName,
            eventId: envelope.eventId,
            eventType: envelope.eventType,
          },
          'After-commit task failed; the event stays processed',
        );
      }
    }
  }
}
