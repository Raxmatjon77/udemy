import type { ActivityRow, ProgressRow } from './progress.repository';

/** One claimed flush batch: snapshots taken atomically with the claim. */
export interface ClaimedBatch {
  /** Members moved from the dirty set into this run's processing set (valid or not). */
  readonly claimed: number;
  readonly progress: readonly ProgressRow[];
  readonly activity: readonly ActivityRow[];
  /** Members whose snapshot was missing or malformed (dropped, logged). */
  readonly invalid: readonly string[];
}

/**
 * The write-behind buffer's dirty queue, as the `ProgressFlushJob` sees it (design D2, schema
 * doc R5 and open point 7). A claim/ack protocol so that no heartbeat is lost between "read"
 * and "delete", and no two flushers apply the same claim:
 *
 * 1. `claim(runId)`: atomically moves up to `limit` members from the dirty set into a
 *    per-run processing set (and registers the run), returning their snapshots.
 * 2. The caller writes the snapshots to Postgres and commits.
 * 3. `ack(runId)`: deletes the processing set. On failure, `requeue(runId)` moves its members
 *    back to the dirty set (keeping their first-dirty score).
 * 4. `recoverStale(cutoffMs)`: re-queues processing sets of runs that claimed before the
 *    cutoff and never acked (a crashed or partitioned flusher).
 *
 * A heartbeat after the claim re-dirties its member, so the next flush writes the newer state;
 * re-queueing a member only ever re-flushes the CURRENT buffer state, which is idempotent
 * (coverage OR, position last-write-wins on the heartbeat time).
 */
export abstract class ProgressFlushQueue {
  abstract claim(runId: string, limit: number, nowMs: number): Promise<ClaimedBatch>;
  abstract ack(runId: string): Promise<void>;
  /** Returns the members re-queued. */
  abstract requeue(runId: string): Promise<number>;
  /** Returns the members re-queued. */
  abstract recoverStale(cutoffMs: number): Promise<number>;
}
