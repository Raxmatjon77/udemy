import type { EventEnvelope } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createFakeDatabase } from '../../testing/fake-database';
import { systemPingRecord } from '../../testing/records';
import { parseEnvelope } from '../envelope/parse-envelope';
import type {
  EventHandlerContract,
  HandlerContext,
  RegisteredEventHandler,
} from '../event-handler.interface';
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

  describe('afterCommit', () => {
    it('runs tasks in order, only after the claim transaction committed', async () => {
      const { db, state } = createFakeDatabase();
      const seen: string[] = [];
      const handle = vi.fn<EventHandlerContract['handle']>(async (_envelope, _trx, ctx) => {
        ctx.afterCommit(() => {
          seen.push(`first (commits=${state.commits})`);
        });
        ctx.afterCommit(async () => {
          seen.push(`second (commits=${state.commits})`);
        });
        seen.push(`handle (commits=${state.commits})`);
      });

      await expect(
        new IdempotentEventProcessor(db).process(registered(handle), envelope),
      ).resolves.toBe('processed');

      expect(seen).toEqual(['handle (commits=0)', 'first (commits=1)', 'second (commits=1)']);
    });

    it('drops the tasks of a rolled-back attempt; the retry registers its own', async () => {
      const { db } = createFakeDatabase();
      const processor = new IdempotentEventProcessor(db);
      const task = vi.fn();
      let attempt = 0;
      const handle = vi.fn<EventHandlerContract['handle']>(async (_envelope, _trx, ctx) => {
        attempt += 1;
        ctx.afterCommit(() => task(attempt));
        if (attempt === 1) throw new Error('db hiccup');
      });

      await expect(processor.process(registered(handle), envelope)).rejects.toThrow('db hiccup');
      expect(task).not.toHaveBeenCalled();

      await expect(processor.process(registered(handle), envelope)).resolves.toBe('processed');
      expect(task.mock.calls).toEqual([[2]]);
    });

    it('never runs tasks for a duplicate delivery', async () => {
      const { db } = createFakeDatabase();
      const processor = new IdempotentEventProcessor(db);
      const task = vi.fn();
      const handle = vi.fn<EventHandlerContract['handle']>(async (_envelope, _trx, ctx) => {
        ctx.afterCommit(task);
      });

      await processor.process(registered(handle), envelope);
      await expect(processor.process(registered(handle), envelope)).resolves.toBe('duplicate');

      expect(task).toHaveBeenCalledTimes(1);
    });

    it('logs a failing task, keeps the event processed and runs the remaining tasks', async () => {
      const { db, state } = createFakeDatabase();
      const later = vi.fn();
      const handle = vi.fn<EventHandlerContract['handle']>(async (_envelope, _trx, ctx) => {
        ctx.afterCommit(() => Promise.reject(new Error('redis down')));
        ctx.afterCommit(later);
      });

      await expect(
        new IdempotentEventProcessor(db).process(registered(handle), envelope),
      ).resolves.toBe('processed');

      expect(later).toHaveBeenCalledTimes(1);
      expect(state.processed.size).toBe(1);
    });

    it('refuses registration after handle returned', async () => {
      const { db } = createFakeDatabase();
      let leaked: HandlerContext | undefined;
      const handle = vi.fn<EventHandlerContract['handle']>(async (_envelope, _trx, ctx) => {
        leaked = ctx;
      });

      await new IdempotentEventProcessor(db).process(registered(handle), envelope);

      expect(() => leaked?.afterCommit(() => undefined)).toThrow(/while the handler runs/);
    });
  });
});
