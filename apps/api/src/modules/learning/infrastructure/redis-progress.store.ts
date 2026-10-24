import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis, type RedisClient } from '../../../shared/redis';
import { ProgressStoreUnavailable } from '../domain/learning.errors';
import {
  acceptPlayedRanges,
  bucketCountOf,
  bucketSpansOf,
  plausibilityBudgetSeconds,
} from '../domain/progress-rules';
import { LearningSettings } from '../application/learning-settings';
import { ProgressRepository, type StoredCoverage } from '../application/ports/progress.repository';
import {
  type LiveLectureProgress,
  ProgressStore,
  type RecordProgressInput,
  type RecordProgressResult,
  type VideoLectureRef,
} from '../application/ports/progress-store';
import {
  PROGRESS_KEY_TTL_SECONDS,
  PROGRESS_SCRIPTS,
  RECORD_CAS_FAILED,
  RedisProgressKeys,
  runScript,
} from './redis-progress.scripts';

/** Compare-and-set attempts per heartbeat before answering 503 (the player retries later). */
export const RECORD_MAX_ATTEMPTS = 3;
/** Lectures per pipeline when the bootstrap reads the buffer. */
const READ_CHUNK = 500;

/**
 * The Redis write-behind `ProgressStore` (design D2, default): a heartbeat touches Redis only
 * (one HMGET, at most one DB read to seed a missing key, one Lua script); `ProgressFlushJob`
 * drains the dirty set into Postgres every 15 s.
 *
 * `record`:
 * 1. Read the key's last heartbeat time (`hb`). On a miss, seed from the DB row of the same
 *    asset and duration (its bitmap, first-watched and last-heartbeat time), so coverage never
 *    regresses after a key expired.
 * 2. Plausibility budget from the last heartbeat time (domain rules), then the accepted ranges
 *    as bucket spans.
 * 3. The `record` script: compare-and-set on `hb`, reset on an asset swap, SETBIT the spans,
 *    HSET position / asset / duration / hb, refresh the TTLs, `ZADD NX lp:dirty`, and the resume
 *    pointer `la:{u}:{c}`; it returns BITCOUNT. A lost CAS (a concurrent heartbeat of the same
 *    user and lecture) re-reads and retries, up to 3 times.
 *
 * Any Redis failure is `ProgressStoreUnavailable` (503: the player keeps the batch).
 */
@Injectable()
export class RedisProgressStore extends ProgressStore {
  private readonly logger = new Logger(RedisProgressStore.name);

  constructor(
    @InjectRedis() private readonly redis: RedisClient,
    private readonly keys: RedisProgressKeys,
    private readonly progress: ProgressRepository,
    private readonly settings: LearningSettings,
  ) {
    super();
  }

  async record(input: RecordProgressInput): Promise<RecordProgressResult> {
    const bucketCount = bucketCountOf(input.durationSeconds, this.settings.bucketSeconds);
    const position = Math.min(
      Math.max(Math.floor(input.positionSeconds), 0),
      input.durationSeconds,
    );
    for (let attempt = 0; attempt < RECORD_MAX_ATTEMPTS; attempt++) {
      // '' = no hash yet: the compare-and-set value of the script.
      const hb = await this.unavailableOnError(() =>
        this.readHeartbeat(input.userId, input.lectureId),
      );
      const seed = hb === '' ? await this.seedFor(input) : null;
      const lastHeartbeatMs = hb !== '' ? Number(hb) : (seed?.lastWatchedAt.getTime() ?? null);
      const budget = plausibilityBudgetSeconds(
        lastHeartbeatMs,
        input.nowMs,
        this.settings.plausibility,
      );
      const { accepted, droppedSeconds } = acceptPlayedRanges(
        input.ranges,
        input.durationSeconds,
        budget,
      );
      const spans = bucketSpansOf(accepted, this.settings.bucketSeconds);
      const covered = await this.unavailableOnError(() =>
        runScript(
          this.redis,
          PROGRESS_SCRIPTS.record,
          [
            this.keys.progress(input.userId, input.lectureId),
            this.keys.coverage(input.userId, input.lectureId),
            this.keys.dirty,
            this.keys.activity(input.userId, input.courseId),
          ],
          [
            hb,
            input.courseId,
            input.mediaAssetId,
            String(input.durationSeconds),
            String(position),
            String(input.nowMs),
            String(PROGRESS_KEY_TTL_SECONDS),
            this.keys.progressMember(input.userId, input.lectureId),
            this.keys.activityMember(input.userId, input.courseId),
            input.lectureId,
            seed === null ? '0' : '1',
            seed === null ? '' : Buffer.from(seed.coverage),
            String(seed?.firstWatchedAt?.getTime() ?? seed?.lastWatchedAt.getTime() ?? input.nowMs),
            String(seed?.lastWatchedAt.getTime() ?? 0),
            ...spans.flatMap((s) => [String(s.first), String(s.last)]),
          ],
        ),
      );
      if (covered === RECORD_CAS_FAILED) continue;
      if (typeof covered !== 'number') throw new Error('Unexpected progress record reply');
      return { coveredBuckets: Math.min(covered, bucketCount), bucketCount, droppedSeconds };
    }
    this.logger.warn(
      `heartbeat of ${input.userId}:${input.lectureId} lost ${RECORD_MAX_ATTEMPTS} compare-and-sets`,
    );
    throw new ProgressStoreUnavailable();
  }

  async readBuffered(
    userId: string,
    lectures: readonly VideoLectureRef[],
  ): Promise<ReadonlyMap<string, LiveLectureProgress>> {
    const result = new Map<string, LiveLectureProgress>();
    try {
      for (let i = 0; i < lectures.length; i += READ_CHUNK) {
        const chunk = lectures.slice(i, i + READ_CHUNK);
        const pipeline = this.redis.pipeline();
        for (const lecture of chunk) {
          pipeline.hmget(this.keys.progress(userId, lecture.lectureId), 'a', 'd', 'p');
          pipeline.bitcount(this.keys.coverage(userId, lecture.lectureId));
        }
        const replies = (await pipeline.exec()) ?? [];
        chunk.forEach((lecture, j) => {
          const [headError, head] = replies[j * 2] ?? [null, null];
          const [countError, count] = replies[j * 2 + 1] ?? [null, null];
          if (headError !== null || countError !== null || !Array.isArray(head)) return;
          const [asset, duration, position] = head as (string | null)[];
          if (asset !== lecture.mediaAssetId || duration !== String(lecture.durationSeconds))
            return;
          const buckets = bucketCountOf(lecture.durationSeconds, this.settings.bucketSeconds);
          result.set(lecture.lectureId, {
            positionSeconds: Math.min(Math.max(Number(position ?? 0), 0), lecture.durationSeconds),
            coveredBuckets: Math.min(typeof count === 'number' ? count : 0, buckets),
            bucketCount: buckets,
          });
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'progress buffer read failed; showing the stored progress');
      return new Map();
    }
    return result;
  }

  async readBufferedActivity(
    userId: string,
    courseId: string,
  ): Promise<{ readonly lectureId: string; readonly atMs: number } | null> {
    try {
      const [lectureId, at] = await this.redis.hmget(
        this.keys.activity(userId, courseId),
        'l',
        't',
      );
      const atMs = Number(at);
      return lectureId && Number.isSafeInteger(atMs) ? { lectureId, atMs } : null;
    } catch (error) {
      this.logger.warn({ err: error }, 'resume pointer read failed; using the stored one');
      return null;
    }
  }

  async touchActivity(
    userId: string,
    courseId: string,
    lectureId: string,
    nowMs: number,
  ): Promise<void> {
    try {
      await runScript(
        this.redis,
        PROGRESS_SCRIPTS.touch,
        [this.keys.activity(userId, courseId), this.keys.dirty],
        [
          lectureId,
          String(nowMs),
          String(PROGRESS_KEY_TTL_SECONDS),
          this.keys.activityMember(userId, courseId),
        ],
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'resume pointer update failed');
    }
  }

  private async readHeartbeat(userId: string, lectureId: string): Promise<string> {
    return (await this.redis.hget(this.keys.progress(userId, lectureId), 'hb')) ?? '';
  }

  /** The DB bitmap to seed a missing key with: only one of the live asset and duration (D3). */
  private async seedFor(input: RecordProgressInput): Promise<StoredCoverage | null> {
    const stored = await this.progress.findCoverage(input.userId, input.lectureId);
    if (
      stored === null ||
      stored.mediaAssetId !== input.mediaAssetId ||
      stored.durationSeconds !== input.durationSeconds
    ) {
      return null;
    }
    return stored;
  }

  private async unavailableOnError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ProgressStoreUnavailable({ cause: error });
    }
  }
}
