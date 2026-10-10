import { randomBytes, randomUUID } from 'node:crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SystemPing } from '@udemy/contracts';
import { createDatabase, type DB, insertOutboxEvent, type Kysely, sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerConfigService } from '../shared/config';
import type { WorkerEnv } from '../shared/config/worker-env.schema';
import { itDatabaseUrl, useIntegrationStack } from '../testing/integration';
import { OutboxRetentionJob } from './outbox-retention.job';
import type { OutboxRetentionOptions } from './outbox-retention.steps';

/**
 * OutboxRetentionJob against the dev Postgres.
 *
 * Determinism: instead of waiting for Debezium to confirm (its offset flush runs every 60 s), the
 * test creates its own TEMPORARY logical slot, points the job at it and plays Debezium itself:
 * `pg_log_standby_snapshot()` writes a running-xacts record, `pg_replication_slot_advance()`
 * confirms up to the flushed WAL, and Postgres moves the slot's catalog_xmin past the test rows,
 * exactly as it does when Debezium confirms. (A fresh slot starts at the minimum catalog_xmin of
 * the existing slots, so creation alone confirms nothing.) Rows inserted after the last advance
 * stay unconfirmed. The slot lives on one held connection and disappears with it.
 *
 * Needs `wal_level=logical` (the dev stack has it). The CI `test` job's Postgres runs without it,
 * so these tests SKIP there (with a message) instead of failing.
 *
 * Isolation: rows are backdated ~2000 h / ~3000 days and the retention windows are 1000 h /
 * 2900 days, so only rows of this file qualify. The outbox rows are SystemPings: Debezium ships
 * them to `system.ping`, where a running dev worker only logs them.
 */
const CONFIG: Partial<WorkerEnv> = { OUTBOX_RETENTION_MAX_BATCHES_PER_RUN: 50 };
const config = {
  get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => CONFIG[key] as WorkerEnv[K],
} as WorkerConfigService;

interface SlotSession {
  /** Advances the slot until its catalog_xmin is above the xmin of outbox row `eventId`. */
  confirmPast(eventId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One dedicated connection that creates a temporary logical slot and runs every later slot
 * command itself (a temporary slot can only be used by the session that created it).
 */
async function openTemporarySlot(name: string): Promise<SlotSession> {
  const db = createDatabase({
    connectionString: itDatabaseUrl(),
    max: 1,
    applicationName: 'udemy-worker-it-slot',
  });
  type Task = (conn: Kysely<DB>) => Promise<void>;
  const queue: Task[] = [];
  let wake: () => void = () => undefined;
  let closed = false;
  let ready: (error?: unknown) => void = () => undefined;
  const created = new Promise<void>((resolve, reject) => {
    ready = (error) => (error === undefined ? resolve() : reject(error));
  });

  const session = db
    .connection()
    .execute(async (conn) => {
      await sql`SELECT pg_create_logical_replication_slot(${name}, 'pgoutput', true)`.execute(conn);
      ready();
      for (;;) {
        const task = queue.shift();
        if (task !== undefined) {
          await task(conn);
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })
    .catch((error: unknown) => ready(error));
  await created;

  const run = (task: Task): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      queue.push(async (conn) => task(conn).then(resolve, reject));
      wake();
    });

  return {
    confirmPast: (eventId) =>
      run(async (conn) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const { rows } = await sql<{ confirmed: boolean }>`
            SELECT age(e.xmin) > age(s.catalog_xmin) AS confirmed
              FROM outbox.events e, pg_replication_slots s
             WHERE e.id = ${eventId}::uuid AND s.slot_name = ${name}
          `.execute(conn);
          if (rows[0]?.confirmed === true) return;
          // A running-xacts record, then (once the walwriter flushed it) confirm up to it.
          const { rows: snap } = await sql<{
            lsn: string;
          }>`SELECT pg_log_standby_snapshot()::text AS lsn`.execute(conn);
          const lsn = snap[0]?.lsn ?? '0/0';
          for (let wait = 0; wait < 50; wait += 1) {
            const { rows: f } = await sql<{
              flushed: boolean;
            }>`SELECT pg_current_wal_flush_lsn() >= ${lsn}::pg_lsn AS flushed`.execute(conn);
            if (f[0]?.flushed === true) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await sql`SELECT pg_replication_slot_advance(${name}, pg_current_wal_flush_lsn())`.execute(
            conn,
          );
        }
        throw new Error(`Slot ${name} never confirmed outbox row ${eventId}`);
      }),
    async close() {
      closed = true;
      wake();
      await session;
      await db.destroy();
    },
  };
}

describe('OutboxRetentionJob (integration: Postgres, temporary logical slot)', () => {
  const it_ = useIntegrationStack();
  const slotName = `it_outbox_${randomBytes(6).toString('hex')}`;
  const consumer = `it-outbox-retention-${randomUUID()}`;
  const eventIds: string[] = [];
  let slot: SlotSession | undefined;
  let skipReason: string | undefined;

  const options = (slot = slotName): OutboxRetentionOptions => ({
    slotName: slot,
    eventsRetentionHours: 1000,
    processedRetentionDays: 2900,
    batchSize: 1,
  });

  async function insertPing(hoursAgo: number): Promise<string> {
    const { id } = await insertOutboxEvent(it_.db, {
      aggregateType: SystemPing.aggregateType,
      aggregateId: `it-outbox-retention-${randomUUID()}`,
      type: SystemPing.qualifiedType,
      payload: { message: 'outbox retention IT', sentAt: new Date().toISOString() },
    });
    await sql`UPDATE outbox.events SET created_at = now() - make_interval(hours => ${hoursAgo}::int) WHERE id = ${id}::uuid`.execute(
      it_.db,
    );
    eventIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (it_.unavailableReason !== undefined) return;
    const { rows } = await sql<{
      walLevel: string;
    }>`SELECT current_setting('wal_level') AS wal_level`.execute(it_.db);
    if (rows[0]?.walLevel !== 'logical') {
      skipReason = `wal_level is ${rows[0]?.walLevel ?? 'unknown'}, not logical: cannot create a test slot`;
      process.stderr.write(`[integration] ${skipReason}. Skipping.\n`);
    }
  });

  afterAll(async () => {
    await slot?.close();
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.events').where('id', 'in', eventIds).execute();
    }
    await it_.db.deleteFrom('outbox.processedEvents').where('consumer', '=', consumer).execute();
  });

  const outboxExists = async (id: string): Promise<boolean> =>
    (await it_.db
      .selectFrom('outbox.events')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()) !== undefined;

  const processedExists = async (eventId: string): Promise<boolean> =>
    (await it_.db
      .selectFrom('outbox.processedEvents')
      .select('eventId')
      .where('consumer', '=', consumer)
      .where('eventId', '=', eventId)
      .executeTakeFirst()) !== undefined;

  it('deletes only expired rows the slot confirmed, keeps the rest, and trims old dedupe rows', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    ctx.skip(skipReason !== undefined, skipReason);

    // Committed before the slot exists: "captured". One expired, one recent.
    const capturedOld = await insertPing(2000);
    const capturedOld2 = await insertPing(2001);
    const capturedRecent = await insertPing(1);
    // Debezium's part: confirm everything committed so far.
    slot = await openTemporarySlot(slotName);
    await slot.confirmPast(capturedRecent);
    // Committed after the last confirmation: never confirmed, however old.
    const unconfirmedOld = await insertPing(2000);

    const oldProcessed = randomUUID();
    const recentProcessed = randomUUID();
    await it_.db
      .insertInto('outbox.processedEvents')
      .values([
        { consumer, eventId: oldProcessed, processedAt: sql<Date>`now() - interval '3000 days'` },
        { consumer, eventId: recentProcessed },
      ])
      .execute();

    const job = new OutboxRetentionJob(it_.db, config, new SchedulerRegistry());

    // A slot that does not exist proves nothing: no outbox row may go. processed_events does
    // not depend on the slot and is trimmed anyway.
    const missing = await job.runOnce(options(`${slotName}_missing`));
    expect(missing.status).toBe('completed');
    expect(missing.outboxEvents).toBe('slot_missing');
    expect(missing.slot).toBeNull();
    expect(missing.heldBack).toBeGreaterThanOrEqual(3);
    expect(await outboxExists(capturedOld)).toBe(true);
    expect(missing.deleted.processed_events).toBeGreaterThanOrEqual(1);
    expect(await processedExists(oldProcessed)).toBe(false);
    expect(await processedExists(recentProcessed)).toBe(true);

    const result = await job.runOnce(options());
    expect(result.status).toBe('completed');
    expect(result.outboxEvents).toBe('completed');
    // A temporary slot counts as active (its creating session holds it).
    expect(result.slot).toMatchObject({ active: true, walStatus: 'reserved' });
    // batchSize 1: the two captured expired rows took (at least) two batches.
    expect(result.deleted.outbox_events).toBeGreaterThanOrEqual(2);
    expect(result.batches.outbox_events).toBeGreaterThanOrEqual(3);
    expect(result.heldBack).toBeGreaterThanOrEqual(1);
    expect(await outboxExists(capturedOld)).toBe(false);
    expect(await outboxExists(capturedOld2)).toBe(false);
    expect(await outboxExists(capturedRecent)).toBe(true);
    expect(await outboxExists(unconfirmedOld)).toBe(true);
    expect(await processedExists(recentProcessed)).toBe(true);
  }, 60_000);
});
