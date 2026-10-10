import { type Executor, sql } from '@udemy/db';

/** One row of `pg_replication_slots` for Debezium's logical slot, as the worker needs it. */
export interface ReplicationSlotState {
  readonly slotName: string;
  /** A walsender (Debezium) is attached right now. */
  readonly active: boolean;
  /**
   * The slot's `catalog_xmin`: the oldest running transaction id at a WAL position the consumer
   * has already confirmed. Every xid below it has finished before that position.
   */
  readonly catalogXmin: string | null;
  /** Last LSN the consumer confirmed (Debezium: after the records were written to Kafka). */
  readonly confirmedFlushLsn: string | null;
  /**
   * `pg_current_wal_lsn() - confirmed_flush_lsn` in bytes. Counts ALL WAL, not just the outbox:
   * while no outbox row is written the slot does not move, so an idle pipeline still shows lag.
   */
  readonly lagBytes: number | null;
  /** `reserved` / `extended` / `unreserved` / `lost` (`lost`: WAL is gone, the slot is useless). */
  readonly walStatus: string | null;
}

/** Raw result columns (snake_case aliases come back camelCased by the CamelCasePlugin). */
interface SlotRow {
  slotName: string;
  active: boolean;
  catalogXmin: string | null;
  confirmedFlushLsn: string | null;
  lagBytes: string | null;
  walStatus: string | null;
}

/** The logical slot `slotName` in the current database; undefined when it does not exist. */
export async function readReplicationSlot(
  executor: Executor,
  slotName: string,
): Promise<ReplicationSlotState | undefined> {
  const { rows } = await sql<SlotRow>`
    SELECT slot_name,
           active,
           catalog_xmin::text AS catalog_xmin,
           confirmed_flush_lsn::text AS confirmed_flush_lsn,
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::text AS lag_bytes,
           wal_status
      FROM pg_replication_slots
     WHERE slot_name = ${slotName}
       AND slot_type = 'logical'
       AND database = current_database()
  `.execute(executor);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { ...row, lagBytes: row.lagBytes === null ? null : Number(row.lagBytes) };
}
