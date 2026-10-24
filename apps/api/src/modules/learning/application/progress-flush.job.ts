import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LearningSettings } from './learning-settings';
import { LearningClock } from './ports/learning-clock';
import { ProgressFlushQueue } from './ports/progress-flush-queue';
import { ProgressRepository } from './ports/progress.repository';
import { TransactionRunner } from './ports/transaction-runner';

export interface FlushReport {
  /** false = another replica held `0x75646d79_06`; nothing was claimed. */
  readonly locked: boolean;
  /** Members moved out of the dirty set by this run. */
  readonly claimed: number;
  /** Progress rows upserted. */
  readonly written: number;
  /** Resume pointers upserted (or ignored as older). */
  readonly activities: number;
  /** Members dropped: no or malformed snapshot, or a CHECK violation (logged). */
  readonly dropped: number;
  /** Members of crashed flushers' claims put back into the dirty set before claiming. */
  readonly recovered: number;
}

const SKIPPED: FlushReport = Object.freeze({
  locked: false,
  claimed: 0,
  written: 0,
  activities: 0,
  dropped: 0,
  recovered: 0,
});

/**
 * `ProgressFlushJob` (design D2, §5; schema doc §8.1, R5, open point 7): drains the Redis
 * write-behind buffer into `learning.lecture_progress` / `course_activity`.
 *
 * One batch (`flushOnce`), all in ONE transaction:
 *
 * 1. `pg_try_advisory_xact_lock(0x75646d79_06)` BEFORE touching Redis: false = another
 *    replica is flushing, claim nothing (a claim taken first would be stranded on a lost lock).
 * 2. Re-queue the processing sets of runs that claimed more than `staleClaimMs` ago and never
 *    acked (a flusher that crashed between claim and ack).
 * 3. Claim ≤ `LEARNING_PROGRESS_FLUSH_BATCH_SIZE` members into this run's processing set,
 *    atomically with their snapshots (Lua).
 * 4. One multi-row upsert (coverage OR on the same asset, position last-write-wins on the
 *    heartbeat time), plus the resume pointers.
 *
 * After COMMIT the claim is acked (the processing set deleted). If anything fails after the
 * claim, the claim is re-queued; if even that fails (Redis gone), step 2 of a later run
 * recovers it. Re-applying is harmless: a re-queued member re-flushes the CURRENT buffer state.
 *
 * `drain` repeats batches while they come back full (bounded per tick); the scheduler runs it
 * every `LEARNING_PROGRESS_FLUSH_INTERVAL_MS` and once more on shutdown (SIGTERM).
 */
@Injectable()
export class ProgressFlushJob {
  private readonly logger = new Logger(ProgressFlushJob.name);

  constructor(
    private readonly queue: ProgressFlushQueue,
    private readonly progress: ProgressRepository,
    private readonly tx: TransactionRunner,
    private readonly clock: LearningClock,
    private readonly settings: LearningSettings,
  ) {}

  async flushOnce(): Promise<FlushReport> {
    const runId = randomUUID();
    // Mutated inside the transaction callback (an object, so control-flow narrowing keeps up).
    const claim = { taken: false };
    let report: FlushReport;
    try {
      report = await this.tx.run(async (trx) => {
        if (!(await this.progress.tryLockFlush(trx))) return SKIPPED;
        const now = this.clock.nowMs();
        const recovered = await this.queue.recoverStale(now - this.settings.staleClaimMs);
        const batch = await this.queue.claim(runId, this.settings.flushBatchSize, now);
        claim.taken = batch.claimed > 0;
        for (const member of batch.invalid) {
          this.logger.warn(`progress flush: dropped ${member} (no or malformed buffer snapshot)`);
        }
        const result =
          batch.progress.length + batch.activity.length === 0
            ? { written: 0, dropped: [] as readonly string[] }
            : await this.progress.writeBatch(trx, batch.progress, batch.activity);
        for (const key of result.dropped) {
          this.logger.error(`progress flush: dropped ${key} (rejected by a CHECK constraint)`);
        }
        return {
          locked: true,
          claimed: batch.claimed,
          written: result.written,
          activities: batch.activity.length,
          dropped: batch.invalid.length + result.dropped.length,
          recovered,
        };
      });
    } catch (error) {
      if (claim.taken) await this.requeueQuietly(runId);
      throw error;
    }
    if (claim.taken) {
      try {
        await this.queue.ack(runId);
      } catch (error) {
        // Committed but not acked: a later run re-queues the claim and re-flushes (harmless).
        this.logger.warn({ err: error }, `progress flush: ack of run ${runId} failed`);
      }
    }
    return report;
  }

  /**
   * Batches until one comes back less than full, the lock is busy, or `maxBatches` ran.
   * Returns the summed report.
   */
  async drain(maxBatches = this.settings.maxBatchesPerTick): Promise<FlushReport> {
    const total = {
      locked: false,
      claimed: 0,
      written: 0,
      activities: 0,
      dropped: 0,
      recovered: 0,
    };
    for (let i = 0; i < maxBatches; i++) {
      const report = await this.flushOnce();
      if (!report.locked) break;
      total.locked = true;
      total.claimed += report.claimed;
      total.written += report.written;
      total.activities += report.activities;
      total.dropped += report.dropped;
      total.recovered += report.recovered;
      if (report.claimed < this.settings.flushBatchSize) break;
    }
    return total;
  }

  private async requeueQuietly(runId: string): Promise<void> {
    try {
      await this.queue.requeue(runId);
    } catch (error) {
      this.logger.warn(
        { err: error },
        `progress flush: re-queue of run ${runId} failed; a later run recovers it`,
      );
    }
  }
}
