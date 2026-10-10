import type { DB, Transaction } from '@udemy/db';
import { describe, expect, it } from 'vitest';
import type { LockedResult } from './media-cleanup.steps';
import {
  HELD_BACK_COUNT_LIMIT,
  type OutboxRetentionContext,
  type OutboxRetentionOptions,
  type OutboxRetentionSql,
  runOutboxRetention,
} from './outbox-retention.steps';
import type { ReplicationSlotState } from './replication-slot';

const TRX = { isTransaction: true } as unknown as Transaction<DB>;

const OPTIONS: OutboxRetentionOptions = {
  slotName: 'udemy_outbox',
  eventsRetentionHours: 72,
  processedRetentionDays: 30,
  batchSize: 2,
};

const SLOT: ReplicationSlotState = {
  slotName: 'udemy_outbox',
  active: true,
  catalogXmin: '35557',
  confirmedFlushLsn: '0/B5F2D78',
  lagBytes: 1024,
  walStatus: 'reserved',
};

class FakeSql implements OutboxRetentionSql {
  readonly calls: string[] = [];
  slot: ReplicationSlotState | undefined = SLOT;
  eventBatches: number[] = [];
  processedBatches: number[] = [];
  heldBack = 0;

  async readSlot(
    _trx: Transaction<DB>,
    slotName: string,
  ): Promise<ReplicationSlotState | undefined> {
    this.calls.push(`readSlot(${slotName})`);
    return this.slot;
  }
  async deleteCapturedEvents(
    _trx: Transaction<DB>,
    o: { slotName: string; retentionHours: number; batchSize: number },
  ): Promise<number> {
    this.calls.push(`deleteCapturedEvents(${o.slotName},${o.retentionHours},${o.batchSize})`);
    return this.eventBatches.shift() ?? 0;
  }
  async countHeldBackEvents(
    _trx: Transaction<DB>,
    o: { slotName: string; retentionHours: number; limit: number },
  ): Promise<number> {
    this.calls.push(`countHeldBackEvents(${o.limit})`);
    return this.heldBack;
  }
  async deleteProcessedEvents(
    _trx: Transaction<DB>,
    o: { retentionDays: number; batchSize: number },
  ): Promise<number> {
    this.calls.push(`deleteProcessedEvents(${o.retentionDays},${o.batchSize})`);
    return this.processedBatches.shift() ?? 0;
  }
}

function context(
  fake: FakeSql,
  o: { maxBatches?: number; lockFreeCalls?: number; stopAfterCalls?: number } = {},
): OutboxRetentionContext & { warnings: string[] } {
  let calls = 0;
  const warnings: string[] = [];
  return {
    sql: fake,
    async runLocked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<LockedResult<T>> {
      calls += 1;
      if (o.lockFreeCalls !== undefined && calls > o.lockFreeCalls) return { acquired: false };
      return { acquired: true, value: await fn(TRX) };
    },
    maxBatches: o.maxBatches ?? 10,
    shouldStop: () => o.stopAfterCalls !== undefined && calls >= o.stopAfterCalls,
    log: { warn: (_ctx, message) => warnings.push(message) },
    warnings,
  };
}

describe('runOutboxRetention', () => {
  it('deletes confirmed outbox rows and old dedupe rows batch by batch until a batch is not full', async () => {
    const fake = new FakeSql();
    fake.eventBatches = [2, 2, 1];
    fake.processedBatches = [2, 0];

    const result = await runOutboxRetention(context(fake), OPTIONS);

    expect(result).toEqual({
      status: 'completed',
      deleted: { outbox_events: 5, processed_events: 2 },
      batches: { outbox_events: 3, processed_events: 2 },
      outboxEvents: 'completed',
      heldBack: 0,
      slot: { active: true, lagBytes: 1024, walStatus: 'reserved' },
    });
    expect(fake.calls).toEqual([
      'readSlot(udemy_outbox)',
      'deleteCapturedEvents(udemy_outbox,72,2)',
      'deleteCapturedEvents(udemy_outbox,72,2)',
      'deleteCapturedEvents(udemy_outbox,72,2)',
      `countHeldBackEvents(${HELD_BACK_COUNT_LIMIT})`,
      'deleteProcessedEvents(30,2)',
      'deleteProcessedEvents(30,2)',
    ]);
  });

  it('keeps every outbox row when the replication slot does not exist, but still trims processed_events', async () => {
    const fake = new FakeSql();
    fake.slot = undefined;
    fake.heldBack = 7;
    fake.processedBatches = [1];
    const ctx = context(fake);

    const result = await runOutboxRetention(ctx, OPTIONS);

    expect(result.outboxEvents).toBe('slot_missing');
    expect(result.deleted).toEqual({ outbox_events: 0, processed_events: 1 });
    expect(result.heldBack).toBe(7);
    expect(result.slot).toBeNull();
    expect(fake.calls.some((c) => c.startsWith('deleteCapturedEvents'))).toBe(false);
    expect(ctx.warnings).toEqual([expect.stringContaining('Replication slot not found')]);
  });

  it('treats a slot without catalog_xmin like a missing slot', async () => {
    const fake = new FakeSql();
    fake.slot = { ...SLOT, catalogXmin: null };

    const result = await runOutboxRetention(context(fake), OPTIONS);

    expect(result.outboxEvents).toBe('slot_missing');
    expect(fake.calls.some((c) => c.startsWith('deleteCapturedEvents'))).toBe(false);
  });

  it('warns when expired rows are held back because the slot has not confirmed them', async () => {
    const fake = new FakeSql();
    fake.heldBack = 3;
    const ctx = context(fake);

    const result = await runOutboxRetention(ctx, OPTIONS);

    expect(result.heldBack).toBe(3);
    expect(ctx.warnings).toEqual([expect.stringContaining('not yet confirmed')]);
  });

  it('stops at the batch limit and reports it', async () => {
    const fake = new FakeSql();
    fake.eventBatches = [2, 2, 2, 2];

    const result = await runOutboxRetention(context(fake, { maxBatches: 2 }), OPTIONS);

    expect(result.outboxEvents).toBe('batch_limit');
    expect(result.batches.outbox_events).toBe(2);
    expect(result.deleted.outbox_events).toBe(4);
    expect(result.status).toBe('completed');
  });

  it('stops without touching anything when another replica holds the lock', async () => {
    const fake = new FakeSql();

    const result = await runOutboxRetention(context(fake, { lockFreeCalls: 0 }), OPTIONS);

    expect(result.status).toBe('locked');
    expect(result.outboxEvents).toBe('not_run');
    expect(fake.calls).toEqual([]);
  });

  it('reports locked when the lock is lost between batches', async () => {
    const fake = new FakeSql();
    fake.eventBatches = [2, 2];

    const result = await runOutboxRetention(context(fake, { lockFreeCalls: 2 }), OPTIONS);

    expect(result.status).toBe('locked');
    expect(result.deleted.outbox_events).toBe(2);
    expect(fake.calls.some((c) => c.startsWith('deleteProcessedEvents'))).toBe(false);
  });

  it('does not start further batches once shutdown began', async () => {
    const fake = new FakeSql();
    fake.eventBatches = [2, 2, 2];
    fake.processedBatches = [2];

    // Stop after the second runLocked call (slot read + first batch).
    const result = await runOutboxRetention(context(fake, { stopAfterCalls: 2 }), OPTIONS);

    expect(result.deleted).toEqual({ outbox_events: 2, processed_events: 0 });
    expect(fake.calls.filter((c) => c.startsWith('deleteCapturedEvents'))).toHaveLength(1);
  });
});
