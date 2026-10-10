import { type DB, sql, type Transaction } from '@udemy/db';
import type { LockedResult } from './media-cleanup.steps';
import { readReplicationSlot, type ReplicationSlotState } from './replication-slot';

/**
 * OutboxRetentionJob logic over two ports (the SQL below, and a runner that opens a transaction
 * holding the advisory lock), so the decisions are unit-testable without Postgres.
 *
 * ## Why deleting `outbox.events` rows is safe
 *
 * Debezium never reads the table: it decodes INSERTs from the WAL through the logical slot
 * `udemy_outbox`, and the slot keeps that WAL until Debezium confirms it. What must not happen is
 * deleting a row whose INSERT Debezium has not delivered yet: if the slot is ever lost or
 * recreated, the table is the only copy left for a manual re-publish. Age alone does not prove
 * delivery (the connector may have been FAILED for days), so a row is deleted only when BOTH hold:
 *
 * 1. `created_at` is older than OUTBOX_EVENTS_RETENTION_HOURS (default 72 h). This is just a
 *    debugging window ("what did we emit yesterday?"), not the safety argument.
 * 2. `age(xmin) > age(slot.catalog_xmin)`, i.e. the inserting transaction id is older than the
 *    slot's `catalog_xmin`. Postgres advances `catalog_xmin` to the oldest transaction that was
 *    still running at a `xl_running_xacts` WAL record, and only once the consumer has confirmed a
 *    position past that record. So every xid below it has COMMITTED before a position that
 *    Debezium confirmed, and Debezium confirms an LSN only after the Kafka producer acknowledged
 *    the records and the offsets were committed. Hence: inserted, decoded, in Kafka.
 *    `age()` makes the comparison wraparound-safe. A row written in a subtransaction has a
 *    subxid newer than its top-level xid, which only errs on the side of keeping it.
 *
 * This needs no per-row LSN (Postgres stores none; `track_commit_timestamp` is off) and no Kafka
 * Connect call: the slot itself is the source of truth, also while the connector is down (rows it
 * confirmed before failing are still deleted; newer ones are kept). If the slot is missing, nothing
 * is deleted from `outbox.events` and a warning is logged. Caveat: if an operator drops the slot
 * and lets Debezium create a fresh one, the new slot's `catalog_xmin` is above every old row, so
 * rows the OLD slot never delivered become deletable. Dropping a lagging slot is the data loss in
 * that case; check `pg_replication_slots` before doing it (infra/docker/README.md).
 *
 * ## Why `outbox.processed_events` rows can go after PROCESSED_EVENTS_RETENTION_DAYS (30)
 *
 * A row is the dedupe key of (consumer, eventId). The same event can only arrive again while a
 * copy of it is still in Kafka: a redelivery after a crash or rebalance, a group that lost its
 * committed offsets (`fromBeginning: true` then rereads the whole retained log), or a DLQ replay.
 * Topic retention is 7 days (PII topics, broker default), so 30 days keeps every dedupe key well
 * past the last moment any copy can be read. The schema refuses values below 8 days; topics with
 * a longer `retention.ms` (prod) need a correspondingly longer value. DLQ replays of an event one
 * handler already processed rely on that handler's row too, which is why `dlq:replay` skips DLQ
 * messages older than this window unless `--allow-stale` is given.
 */

export interface OutboxRetentionOptions {
  readonly slotName: string;
  readonly eventsRetentionHours: number;
  readonly processedRetentionDays: number;
  readonly batchSize: number;
}

/** The operational SQL of the job (one batch per call). */
export interface OutboxRetentionSql {
  readSlot(trx: Transaction<DB>, slotName: string): Promise<ReplicationSlotState | undefined>;
  /** Deletes up to `batchSize` expired rows the slot has confirmed. Returns the count. */
  deleteCapturedEvents(
    trx: Transaction<DB>,
    options: { slotName: string; retentionHours: number; batchSize: number },
  ): Promise<number>;
  /** Expired rows the slot has NOT confirmed yet (counted up to `limit`). */
  countHeldBackEvents(
    trx: Transaction<DB>,
    options: { slotName: string; retentionHours: number; limit: number },
  ): Promise<number>;
  /** Deletes up to `batchSize` dedupe rows older than `retentionDays`. Returns the count. */
  deleteProcessedEvents(
    trx: Transaction<DB>,
    options: { retentionDays: number; batchSize: number },
  ): Promise<number>;
}

/** Held-back rows are counted up to this many (enough for a warning, bounded cost). */
export const HELD_BACK_COUNT_LIMIT = 10_000;

const slotXmin = (slotName: string) => sql`
  SELECT catalog_xmin FROM pg_replication_slots
   WHERE slot_name = ${slotName} AND slot_type = 'logical' AND database = current_database()
`;

const expiredBefore = (hours: number) => sql`now() - make_interval(hours => ${hours}::int)`;

export const dbOutboxRetentionSql: OutboxRetentionSql = {
  readSlot: (trx, slotName) => readReplicationSlot(trx, slotName),

  async deleteCapturedEvents(trx, { slotName, retentionHours, batchSize }) {
    // PK subselect bounded by LIMIT, oldest first via events_created_at_idx.
    const result = await sql`
      DELETE FROM outbox.events
       WHERE id IN (
         SELECT e.id
           FROM outbox.events e
           JOIN (${slotXmin(slotName)}) s ON s.catalog_xmin IS NOT NULL
          WHERE e.created_at < ${expiredBefore(retentionHours)}
            AND age(e.xmin) > age(s.catalog_xmin)
          ORDER BY e.created_at
          LIMIT ${batchSize}
       )
    `.execute(trx);
    return Number(result.numAffectedRows ?? 0n);
  },

  async countHeldBackEvents(trx, { slotName, retentionHours, limit }) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1
          FROM outbox.events e
          LEFT JOIN (${slotXmin(slotName)}) s ON true
         WHERE e.created_at < ${expiredBefore(retentionHours)}
           AND (s.catalog_xmin IS NULL OR NOT (age(e.xmin) > age(s.catalog_xmin)))
         LIMIT ${limit}
      ) held
    `.execute(trx);
    return rows[0]?.n ?? 0;
  },

  async deleteProcessedEvents(trx, { retentionDays, batchSize }) {
    // ctid subselect: the PK is (consumer, event_id), and there is no index on processed_at.
    const result = await sql`
      DELETE FROM outbox.processed_events
       WHERE ctid = ANY (ARRAY(
         SELECT ctid FROM outbox.processed_events
          WHERE processed_at < now() - make_interval(days => ${retentionDays}::int)
          LIMIT ${batchSize}
       ))
    `.execute(trx);
    return Number(result.numAffectedRows ?? 0n);
  },
};

export interface OutboxRetentionContext {
  readonly sql: OutboxRetentionSql;
  /** Runs `fn` in a transaction that holds the outbox retention advisory lock. */
  runLocked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<LockedResult<T>>;
  readonly maxBatches: number;
  shouldStop(): boolean;
  readonly log: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}

export type OutboxEventsOutcome =
  /** Deleted what the slot confirmed (possibly nothing). */
  | 'completed'
  /** The slot does not exist (or has no catalog_xmin): nothing proves capture, nothing deleted. */
  | 'slot_missing'
  /** Stopped at OUTBOX_RETENTION_MAX_BATCHES_PER_RUN with more rows left. */
  | 'batch_limit';

export interface OutboxRetentionRunResult {
  readonly status: 'completed' | 'locked';
  readonly deleted: { readonly outbox_events: number; readonly processed_events: number };
  readonly batches: { readonly outbox_events: number; readonly processed_events: number };
  readonly outboxEvents: OutboxEventsOutcome | 'not_run';
  /** Expired outbox rows kept because the slot has not confirmed them (capped). */
  readonly heldBack: number;
  readonly slot: Pick<ReplicationSlotState, 'active' | 'lagBytes' | 'walStatus'> | null;
}

interface LoopResult {
  readonly deleted: number;
  readonly batches: number;
  readonly status: 'done' | 'batch_limit' | 'stopped' | 'locked';
}

async function deleteInBatches(
  ctx: OutboxRetentionContext,
  batchSize: number,
  runBatch: (trx: Transaction<DB>) => Promise<number>,
): Promise<LoopResult> {
  let deleted = 0;
  let batches = 0;
  while (batches < ctx.maxBatches) {
    if (ctx.shouldStop()) return { deleted, batches, status: 'stopped' };
    const result = await ctx.runLocked(runBatch);
    if (!result.acquired) return { deleted, batches, status: 'locked' };
    batches += 1;
    deleted += result.value;
    if (result.value < batchSize) return { deleted, batches, status: 'done' };
  }
  return { deleted, batches, status: 'batch_limit' };
}

/** One full retention run: outbox.events (slot-confirmed only), then outbox.processed_events. */
export async function runOutboxRetention(
  ctx: OutboxRetentionContext,
  options: OutboxRetentionOptions,
): Promise<OutboxRetentionRunResult> {
  const { slotName, eventsRetentionHours, processedRetentionDays, batchSize } = options;
  const deleted = { outbox_events: 0, processed_events: 0 };
  const batches = { outbox_events: 0, processed_events: 0 };
  const result = (
    status: 'completed' | 'locked',
    outboxEvents: OutboxEventsOutcome | 'not_run',
    heldBack: number,
    slot: ReplicationSlotState | undefined,
  ): OutboxRetentionRunResult => ({
    status,
    deleted: { ...deleted },
    batches: { ...batches },
    outboxEvents,
    heldBack,
    slot:
      slot === undefined
        ? null
        : { active: slot.active, lagBytes: slot.lagBytes, walStatus: slot.walStatus },
  });

  const slotRead = await ctx.runLocked((trx) => ctx.sql.readSlot(trx, slotName));
  if (!slotRead.acquired) return result('locked', 'not_run', 0, undefined);
  const slot = slotRead.value;

  // 1. outbox.events: only rows the slot has confirmed.
  let outboxEvents: OutboxEventsOutcome;
  if (slot === undefined || slot.catalogXmin === null) {
    outboxEvents = 'slot_missing';
    ctx.log.warn(
      { slotName },
      'Replication slot not found: outbox.events rows are kept (nothing proves Debezium captured them)',
    );
  } else {
    const loop = await deleteInBatches(ctx, batchSize, (trx) =>
      ctx.sql.deleteCapturedEvents(trx, {
        slotName,
        retentionHours: eventsRetentionHours,
        batchSize,
      }),
    );
    deleted.outbox_events = loop.deleted;
    batches.outbox_events = loop.batches;
    if (loop.status === 'locked') return result('locked', 'completed', 0, slot);
    outboxEvents = loop.status === 'batch_limit' ? 'batch_limit' : 'completed';
  }

  // 2. Expired rows still waiting for the slot = Debezium is behind (or the slot is gone).
  let heldBack = 0;
  if (!ctx.shouldStop()) {
    const held = await ctx.runLocked((trx) =>
      ctx.sql.countHeldBackEvents(trx, {
        slotName,
        retentionHours: eventsRetentionHours,
        limit: HELD_BACK_COUNT_LIMIT,
      }),
    );
    if (!held.acquired) return result('locked', outboxEvents, 0, slot);
    heldBack = held.value;
    if (heldBack > 0 && outboxEvents !== 'slot_missing') {
      ctx.log.warn(
        {
          slotName,
          heldBack,
          slotActive: slot?.active,
          lagBytes: slot?.lagBytes,
          retentionHours: eventsRetentionHours,
        },
        'Expired outbox.events rows not yet confirmed by the replication slot are kept; is the Debezium connector running?',
      );
    }
  }

  // 3. outbox.processed_events.
  const loop = await deleteInBatches(ctx, batchSize, (trx) =>
    ctx.sql.deleteProcessedEvents(trx, { retentionDays: processedRetentionDays, batchSize }),
  );
  deleted.processed_events = loop.deleted;
  batches.processed_events = loop.batches;
  return result(loop.status === 'locked' ? 'locked' : 'completed', outboxEvents, heldBack, slot);
}
