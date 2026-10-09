import { describe, expect, it, vi } from 'vitest';
import { createFakeDatabase } from '../testing/fake-database';
import { systemPingRecord } from '../testing/records';
import type { DeadLetter, DeadLetterPublisher } from './dead-letter/dead-letter';
import type { EventHandlerContract, RegisteredEventHandler } from './event-handler.interface';
import type { EventHandlerRegistry } from './event-handler.registry';
import { IdempotentEventProcessor } from './idempotency/idempotent-event-processor';
import { MessageDispatcher } from './message-dispatcher';
import { NonRetryableError } from './non-retryable.error';

function setup(handle: EventHandlerContract['handle']) {
  const { db } = createFakeDatabase();
  const handler: RegisteredEventHandler = {
    topic: 'system.ping',
    eventType: 'SystemPing',
    consumerName: 'TestHandler',
    handler: { handle },
  };
  const registry = {
    handlersFor: (topic: string, eventType: string) =>
      topic === handler.topic && eventType === handler.eventType ? [handler] : [],
  } as unknown as EventHandlerRegistry;
  const deadLetters: DeadLetter[] = [];
  const publisher: DeadLetterPublisher = { publish: async (dl) => void deadLetters.push(dl) };
  const dispatcher = new MessageDispatcher(registry, new IdempotentEventProcessor(db), publisher, {
    maxRetries: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  return { dispatcher, deadLetters };
}

describe('MessageDispatcher', () => {
  it('handles an event once even if Kafka redelivers it', async () => {
    const handle = vi.fn(async () => undefined);
    const { dispatcher, deadLetters } = setup(handle);

    await dispatcher.dispatch(systemPingRecord());
    await dispatcher.dispatch(systemPingRecord());

    expect(handle).toHaveBeenCalledTimes(1);
    expect(deadLetters).toHaveLength(0);
  });

  it('retries a failing handler, then dead-letters it with attempts and consumer', async () => {
    const handle = vi.fn(async () => {
      throw new Error('downstream unavailable');
    });
    const { dispatcher, deadLetters } = setup(handle);

    await expect(dispatcher.dispatch(systemPingRecord())).resolves.toBeUndefined();

    expect(handle).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
    expect(deadLetters).toEqual([
      expect.objectContaining({
        attempts: 3,
        consumerName: 'TestHandler',
        error: expect.any(Error),
      }),
    ]);
  });

  it('dead-letters non-retryable failures without retrying', async () => {
    const handle = vi.fn(async () => {
      throw new NonRetryableError('payload breaks the contract');
    });
    const { dispatcher, deadLetters } = setup(handle);

    await dispatcher.dispatch(systemPingRecord());

    expect(handle).toHaveBeenCalledTimes(1);
    expect(deadLetters[0]?.attempts).toBe(1);
  });

  it('dead-letters an unreadable message without calling any handler', async () => {
    const handle = vi.fn(async () => undefined);
    const { dispatcher, deadLetters } = setup(handle);

    await dispatcher.dispatch(systemPingRecord({ value: Buffer.from('{oops') }));

    expect(handle).not.toHaveBeenCalled();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.attempts).toBe(1);
    expect(deadLetters[0]?.consumerName).toBeUndefined();
  });

  it('skips events no handler is interested in', async () => {
    const handle = vi.fn(async () => undefined);
    const { dispatcher, deadLetters } = setup(handle);
    const other = systemPingRecord();
    other.headers = { ...other.headers, eventType: 'SomethingElse.v1' };

    await dispatcher.dispatch(other);

    expect(handle).not.toHaveBeenCalled();
    expect(deadLetters).toHaveLength(0);
  });
});
