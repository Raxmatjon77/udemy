import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@udemy/contracts';
import { ZodError } from 'zod';
import { DEAD_LETTER_PUBLISHER, type DeadLetterPublisher } from './dead-letter/dead-letter';
import type { InboundRecord } from './envelope/inbound-record';
import { parseEnvelope } from './envelope/parse-envelope';
import type { RegisteredEventHandler } from './event-handler.interface';
import { EventHandlerRegistry } from './event-handler.registry';
import { IdempotentEventProcessor } from './idempotency/idempotent-event-processor';
import { NonRetryableError } from './non-retryable.error';
import { RETRY_POLICY } from './retry/retry-policy.provider';
import {
  RetriesExhaustedError,
  retryWithBackoff,
  type RetryPolicy,
} from './retry/retry-with-backoff';

/** Malformed input and payload contract violations will fail the same way every time. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof NonRetryableError) && !(error instanceof ZodError);
}

/**
 * Handles one consumed record end to end, independent of the Kafka client:
 *   parse envelope -> find handlers -> per handler: retry(idempotent process) -> DLQ on failure.
 *
 * Resolving means "done, commit the offset" (also after a DLQ publish).
 * Rejecting means "do not commit": only when the DLQ publish fails or on shutdown,
 * so the message is redelivered instead of lost.
 */
@Injectable()
export class MessageDispatcher {
  private readonly logger = new Logger(MessageDispatcher.name);
  private readonly shutdown = new AbortController();

  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly processor: IdempotentEventProcessor,
    @Inject(DEAD_LETTER_PUBLISHER) private readonly deadLetters: DeadLetterPublisher,
    @Inject(RETRY_POLICY) private readonly retryPolicy: RetryPolicy,
  ) {}

  /** Stops pending retry waits so shutdown is not delayed by backoff sleeps. */
  abort(): void {
    this.shutdown.abort();
  }

  async dispatch(record: InboundRecord): Promise<void> {
    let envelope: EventEnvelope;
    try {
      envelope = parseEnvelope(record);
    } catch (error) {
      this.logger.error(
        { err: error, topic: record.topic, offset: record.offset },
        'Unreadable message',
      );
      await this.deadLetters.publish({ record, error, attempts: 1 });
      return;
    }

    const handlers = this.registry.handlersFor(record.topic, envelope.eventType);
    if (handlers.length === 0) {
      this.logger.debug(
        { eventType: envelope.eventType, topic: record.topic },
        'No handler, skipping',
      );
      return;
    }
    // Sequential on purpose: keeps per-partition ordering for every handler.
    for (const registered of handlers) {
      await this.runHandler(registered, envelope, record);
    }
  }

  private async runHandler(
    registered: RegisteredEventHandler,
    envelope: EventEnvelope,
    record: InboundRecord,
  ): Promise<void> {
    const context = {
      consumer: registered.consumerName,
      eventId: envelope.eventId,
      eventType: envelope.eventType,
    };
    try {
      const outcome = await retryWithBackoff(() => this.processor.process(registered, envelope), {
        ...this.retryPolicy,
        isRetryable,
        signal: this.shutdown.signal,
        onRetry: (error, retryNumber, delayMs) =>
          this.logger.warn(
            { ...context, err: error, retryNumber, delayMs },
            'Handler failed, retrying',
          ),
      });
      this.logger.debug({ ...context, outcome }, 'Event handled');
    } catch (error) {
      // Anything else (AbortError on shutdown) propagates: the offset stays uncommitted.
      if (!(error instanceof RetriesExhaustedError)) throw error;
      this.logger.error(
        { ...context, err: error.cause, attempts: error.attempts },
        'Handler failed, sending to DLQ',
      );
      await this.deadLetters.publish({
        record,
        error: error.cause,
        attempts: error.attempts,
        consumerName: registered.consumerName,
      });
    }
  }
}
