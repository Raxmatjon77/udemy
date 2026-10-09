import type { EventEnvelope } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createFakeDatabase } from '../../testing/fake-database';
import { systemPingRecord } from '../../testing/records';
import { parseEnvelope } from '../envelope/parse-envelope';
import type { EventHandlerContract, RegisteredEventHandler } from '../event-handler.interface';
import { IdempotentEventProcessor } from './idempotent-event-processor';

function registered(
  handle: EventHandlerContract['handle'],
  consumerName = 'TestHandler',
): RegisteredEventHandler {
  return { topic: 'system.ping', eventType: 'SystemPing', consumerName, handler: { handle } };
}

describe('IdempotentEventProcessor', () => {
  const envelope: EventEnvelope = parseEnvelope(systemPingRecord());

  it('runs the handler once; a redelivered event is skipped as a duplicate', async () => {
    const { db, state } = createFakeDatabase();
    const processor = new IdempotentEventProcessor(db);
    const handle = vi.fn(async () => undefined);

    await expect(processor.process(registered(handle), envelope)).resolves.toBe('processed');
    await expect(processor.process(registered(handle), envelope)).resolves.toBe('duplicate');

    expect(handle).toHaveBeenCalledTimes(1);
    expect(state.commits).toBe(2);
  });

  it('uses INSERT ... ON CONFLICT DO NOTHING on outbox.processed_events', async () => {
    const { db, state } = createFakeDatabase();

    await new IdempotentEventProcessor(db).process(
      registered(async () => undefined),
      envelope,
    );

    expect(state.executedSql[0]).toMatch(
      /insert into "outbox"\."processed_events" \("consumer", "event_id"\) values \(\$1, \$2\) on conflict \("consumer", "event_id"\) do nothing returning "event_id"/,
    );
  });

  it('passes the open transaction to the handler', async () => {
    const { db } = createFakeDatabase();
    const handle = vi.fn<EventHandlerContract['handle']>(async () => undefined);

    await new IdempotentEventProcessor(db).process(registered(handle), envelope);

    expect(handle.mock.calls[0]?.[1].isTransaction).toBe(true);
  });

  it('rolls back the claim when the handler fails, so a retry processes the event', async () => {
    const { db, state } = createFakeDatabase();
    const processor = new IdempotentEventProcessor(db);
    const handle = vi
      .fn<EventHandlerContract['handle']>()
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce(undefined);

    await expect(processor.process(registered(handle), envelope)).rejects.toThrow('smtp down');
    expect(state.rollbacks).toBe(1);
    expect(state.processed.size).toBe(0);

    await expect(processor.process(registered(handle), envelope)).resolves.toBe('processed');
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('tracks idempotency per consumer: two handlers each process the event once', async () => {
    const { db } = createFakeDatabase();
    const processor = new IdempotentEventProcessor(db);
    const handle = vi.fn(async () => undefined);

    await processor.process(registered(handle, 'SendWelcomeEmail'), envelope);
    await processor.process(registered(handle, 'UpdateSearchIndex'), envelope);
    await processor.process(registered(handle, 'SendWelcomeEmail'), envelope);

    expect(handle).toHaveBeenCalledTimes(2);
  });
});
