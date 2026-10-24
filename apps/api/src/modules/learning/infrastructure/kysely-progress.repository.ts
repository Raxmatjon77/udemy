import { Injectable } from '@nestjs/common';
import {
  type DB,
  type Executor,
  getCourseActivity,
  getLectureCoverage,
  LEARNING_PROGRESS_FLUSH_LOCK_KEY,
  listCourseLectureProgress,
  MAX_PROGRESS_BATCH,
  sql,
  type Transaction,
  tryAdvisoryXactLock,
  upsertCourseActivity,
  upsertLectureProgress,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type ActivityRow,
  type ProgressBatchResult,
  ProgressRepository,
  type ProgressRow,
  type StoredCoverage,
  type StoredProgress,
} from '../application/ports/progress.repository';
import { isCheckViolation } from './learning-constraint-errors';

function rowKey(r: { userId: string; lectureId: string }): string {
  return `${r.userId}:${r.lectureId}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Keeps the newest activity per (user, course): the upsert cannot touch one row twice. */
function newestActivities(rows: readonly ActivityRow[]): ActivityRow[] {
  const byKey = new Map<string, ActivityRow>();
  for (const row of rows) {
    const key = `${row.userId.toLowerCase()}:${row.courseId.toLowerCase()}`;
    const current = byKey.get(key);
    if (current === undefined || row.accessedAt > current.accessedAt) byKey.set(key, row);
  }
  return [...byKey.values()];
}

/**
 * `learning.lecture_progress` / `course_activity` through the `@udemy/db` §8.1 SQL. The batch
 * statement runs under a savepoint: a CHECK violation (23514, e.g. a duration the DB refuses)
 * rolls back to it and retries the rows one by one, each under its own savepoint, dropping
 * only the offenders (§8.1 "retry row by row, drop and log"). The surrounding transaction and
 * its `_06` lock survive.
 */
@Injectable()
export class KyselyProgressRepository extends ProgressRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  tryLockFlush(trx: Transaction<DB>): Promise<boolean> {
    return tryAdvisoryXactLock(trx, LEARNING_PROGRESS_FLUSH_LOCK_KEY);
  }

  async writeBatch(
    trx: Transaction<DB>,
    progress: readonly ProgressRow[],
    activity: readonly ActivityRow[],
  ): Promise<ProgressBatchResult> {
    let written = 0;
    const dropped: string[] = [];
    for (const chunk of chunks(progress, MAX_PROGRESS_BATCH)) {
      const result = await this.withSavepoint(trx, 'lp_batch', () =>
        upsertLectureProgress(trx, chunk),
      );
      if (result.ok) {
        written += result.value.length;
        continue;
      }
      for (const row of chunk) {
        const one = await this.withSavepoint(trx, 'lp_row', () =>
          upsertLectureProgress(trx, [row]),
        );
        if (one.ok) written += 1;
        else dropped.push(rowKey(row));
      }
    }
    for (const chunk of chunks(newestActivities(activity), MAX_PROGRESS_BATCH)) {
      await upsertCourseActivity(trx, chunk);
    }
    return { written, dropped };
  }

  async writeOne(
    trx: Transaction<DB>,
    progress: ProgressRow,
    activity: ActivityRow,
  ): Promise<StoredProgress> {
    const [state] = await upsertLectureProgress(trx, [progress]);
    await upsertCourseActivity(trx, [activity]);
    if (state === undefined)
      throw new Error(`progress upsert of ${rowKey(progress)} returned no row`);
    return state;
  }

  async writeActivity(ex: Executor, activity: ActivityRow): Promise<void> {
    await upsertCourseActivity(ex, [activity]);
  }

  async findCoverage(
    userId: string,
    lectureId: string,
    ex: Executor = this.db,
  ): Promise<StoredCoverage | null> {
    const row = await getLectureCoverage(ex, userId, lectureId);
    if (row === null) return null;
    return {
      mediaAssetId: row.mediaAssetId,
      durationSeconds: row.durationSeconds,
      positionSeconds: row.positionSeconds,
      coverage: row.coverage,
      firstWatchedAt: null,
      lastWatchedAt: row.lastWatchedAt,
    };
  }

  listCourseProgress(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<readonly (StoredProgress & { readonly courseId: string })[]> {
    return listCourseLectureProgress(ex, userId, courseId);
  }

  async findActivity(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<{ readonly lectureId: string; readonly accessedAt: Date } | null> {
    const row = await getCourseActivity(ex, userId, courseId);
    return row === null ? null : { lectureId: row.lastLectureId, accessedAt: row.lastAccessedAt };
  }

  /** Runs `work` under `SAVEPOINT name`; a CHECK violation rolls back to it (ok: false). */
  private async withSavepoint<T>(
    trx: Transaction<DB>,
    name: 'lp_batch' | 'lp_row',
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    await sql`SAVEPOINT ${sql.raw(name)}`.execute(trx);
    try {
      const value = await work();
      await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(trx);
      return { ok: true, value };
    } catch (error) {
      if (!isCheckViolation(error)) throw error;
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`.execute(trx);
      await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(trx);
      return { ok: false };
    }
  }
}
