import { randomUUID } from 'node:crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { afterAll, describe, expect, it } from 'vitest';
import { OutboxPublisher } from '../../shared/outbox';
import type { RedisClient } from '../../shared/redis';
import {
  deleteTestUsers,
  useIntegrationDatabase,
  useIntegrationRedis,
} from '../../testing/integration';
import { insertCatalogTestUser } from '../catalog/testing/catalog-it';
import { CompletionRecorder } from './application/completion-recorder';
import { LearnerAccess } from './application/learner-access';
import { ProgressFlushJob } from './application/progress-flush.job';
import {
  ARTICLE,
  COURSE,
  curriculumOf,
  FakeAccessCache,
  FakeCatalog,
  FakeClock,
  FakeEnrollment,
  FakeRateLimiter,
  lecture,
  QUIZ,
  RESOURCE,
  testSettings,
  VIDEO,
} from './application/testing/learning.fakes';
import { RecordHeartbeatCommand } from './application/use-cases/record-heartbeat.command';
import { KyselyLearningRepository } from './infrastructure/kysely-learning.repository';
import { KyselyProgressRepository } from './infrastructure/kysely-progress.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxLearningEventPublisher } from './infrastructure/outbox-learning-event.publisher';
import { ProgressFlushScheduler } from './infrastructure/progress-flush.scheduler';
import { RedisProgressFlushQueue } from './infrastructure/redis-progress-flush.queue';
import { RedisProgressKeys } from './infrastructure/redis-progress.scripts';
import { RedisProgressStore } from './infrastructure/redis-progress.store';
import {
  deleteLearningTestData,
  deleteRedisPrefix,
  learningEventTypes,
} from './testing/learning-it';

/*
 * P5-T10 against the integration Postgres + Redis, without Nest: the real Kysely repositories
 * (the @udemy/db §8.1/§8.2 SQL), the real Redis buffer under a per-file key prefix, the outbox,
 * and fakes only for catalog / enrollment (soft references: any ids work).
 *
 * - the flush end to end (coverage OR, position last-write-wins, resume pointer);
 * - a crashed flusher's claim recovered by a later run; two "replicas" flushing at once;
 * - a heartbeat racing the flush loses no bits;
 * - the R1 races: parallel completions of one lecture -> one LectureCompleted; the last two
 *   lectures in parallel -> one CourseCompleted;
 * - the SIGTERM final flush.
 *
 * `_06` is a process-wide advisory lock: a dev api running its own ProgressFlushJob on the same
 * database can hold it for a moment, so flushes retry a bounded number of times.
 */
describe('learning progress + completions (integration: Postgres, Redis)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const itRedis = useIntegrationRedis();
  const prefix = `it:lrn-db:${randomUUID().slice(0, 8)}:`;
  const userIds: string[] = [];
  const settings = testSettings({ flushBatchSize: 50 });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  function wire() {
    const db = pg.db;
    const redis = itRedis.redis as unknown as RedisClient;
    const clock = new FakeClock(Date.now());
    const keys = new RedisProgressKeys(prefix);
    const catalog = new FakeCatalog();
    const enrollment = new FakeEnrollment();
    const completions = new KyselyLearningRepository(db);
    const progress = new KyselyProgressRepository(db);
    const tx = new KyselyTransactionRunner(db);
    const events = new OutboxLearningEventPublisher(new OutboxPublisher());
    const store = new RedisProgressStore(redis, keys, progress, settings);
    const queue = new RedisProgressFlushQueue(redis, keys);
    const recorder = new CompletionRecorder(completions, events);
    const access = new LearnerAccess(
      catalog.asFacade(),
      enrollment.asFacade(),
      new FakeAccessCache(),
    );
    const heartbeat = new RecordHeartbeatCommand(
      new FakeRateLimiter(),
      access,
      store,
      completions,
      recorder,
      tx,
      clock,
      settings,
    );
    const job = new ProgressFlushJob(queue, progress, tx, clock, settings);
    return {
      db,
      clock,
      keys,
      catalog,
      enrollment,
      completions,
      progress,
      tx,
      store,
      queue,
      recorder,
      heartbeat,
      job,
    };
  }

  async function learner(w: ReturnType<typeof wire>, label: string): Promise<string> {
    const id = await insertCatalogTestUser(pg.db, `learning-${label}`);
    userIds.push(id);
    w.enrollment.active.add(`${id}:${COURSE}`);
    return id;
  }

  async function watch(
    w: ReturnType<typeof wire>,
    userId: string,
    from: number,
    to: number,
  ): Promise<void> {
    w.clock.advance(to - from);
    await w.heartbeat.execute({
      userId,
      courseId: COURSE,
      lectureId: VIDEO,
      positionSeconds: to,
      ranges: [{ from, to }],
    });
  }

  /** Drains until a run got the lock and the buffer is empty (bounded retries). */
  async function flushAll(w: ReturnType<typeof wire>): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const report = await w.job.drain(100);
      if (report.locked && (await itRedis.redis.zcard(w.keys.dirty)) === 0) return;
    }
    throw new Error('could not flush the test buffer (lock _06 kept busy)');
  }

  afterAll(async () => {
    if (itRedis.available) await deleteRedisPrefix(itRedis.redis, prefix);
    if (!pg.available) return;
    await deleteLearningTestData(pg.db, userIds);
    await deleteTestUsers(pg.db, userIds);
  });

  it('flushes coverage, position and the resume pointer; coverage ORs across flushes', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'flush');
    await watch(w, userId, 0, 30);
    await flushAll(w);
    await watch(w, userId, 30, 60);
    await flushAll(w);
    const [row] = await w.progress.listCourseProgress(userId, COURSE);
    expect(row).toMatchObject({
      lectureId: VIDEO,
      positionSeconds: 60,
      coveredBuckets: 12,
      bucketCount: 20,
    });
    expect(await w.progress.findActivity(userId, COURSE)).toMatchObject({ lectureId: VIDEO });
    expect(await itRedis.redis.zcard(w.keys.runs)).toBe(0);

    // the Redis key expires; the next heartbeat seeds from the DB and keeps the old bits
    await itRedis.redis.del(w.keys.progress(userId, VIDEO), w.keys.coverage(userId, VIDEO));
    await watch(w, userId, 60, 65);
    await flushAll(w);
    const [after] = await w.progress.listCourseProgress(userId, COURSE);
    expect(after).toMatchObject({ positionSeconds: 65, coveredBuckets: 13 });
  });

  it("recovers a crashed flusher's claim (claimed, never acked) on a later run", async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'crash');
    await watch(w, userId, 0, 30);
    const crashed = randomUUID();
    const stolen = await w.queue.claim(crashed, 500, w.clock.nowMs()); // ... and the pod dies
    expect(stolen.claimed).toBeGreaterThan(0);
    expect(await w.progress.listCourseProgress(userId, COURSE)).toEqual([]);

    w.clock.advance(61);
    await flushAll(w);
    const [row] = await w.progress.listCourseProgress(userId, COURSE);
    expect(row).toMatchObject({ positionSeconds: 30, coveredBuckets: 6 });
    expect(await itRedis.redis.exists(w.keys.processing(crashed))).toBe(0);
  });

  it('two replicas flushing at once write every member exactly once, with nothing stranded', async (ctx) => {
    skip(ctx);
    const a = wire();
    const b = { ...a, job: new ProgressFlushJob(a.queue, a.progress, a.tx, a.clock, settings) };
    const users: string[] = [];
    for (let i = 0; i < 30; i++) {
      const userId = await learner(a, `replica-${i}`);
      users.push(userId);
      await watch(a, userId, 0, 10);
    }
    await Promise.all([a.job.drain(100), b.job.drain(100), a.job.drain(100)]);
    await flushAll(a);
    const rows = await pg.db
      .selectFrom('learning.lectureProgress')
      .select(['userId', 'positionSeconds'])
      .where('userId', 'in', users)
      .execute();
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.positionSeconds === 10)).toBe(true);
    expect(await itRedis.redis.zcard(a.keys.runs)).toBe(0);
  });

  it('a heartbeat landing between claim and commit loses no bits (R5)', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'race');
    await watch(w, userId, 0, 30);
    // claim inside the job, then a heartbeat before the batch commits
    const original = w.progress.writeBatch.bind(w.progress);
    w.progress.writeBatch = async (trx, rows, activity) => {
      await watch(w, userId, 30, 45);
      return original(trx, rows, activity);
    };
    await w.job.flushOnce();
    w.progress.writeBatch = original;
    await flushAll(w);
    const [row] = await w.progress.listCourseProgress(userId, COURSE);
    expect(row).toMatchObject({ positionSeconds: 45, coveredBuckets: 9 });
  });

  it('parallel completions of one lecture: one row, one LectureCompleted (R1)', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'r1-lecture');
    const curriculum = curriculumOf();
    const article = curriculum.sections[0]!.lectures.find((l) => l.id === ARTICLE)!;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        w.tx.run((trx) =>
          w.recorder.complete(trx, { userId, curriculum, lecture: article, cause: 'MANUAL' }),
        ),
      ),
    );
    expect(await learningEventTypes(pg.db, userId)).toEqual(['LectureCompleted.v1']);
    expect(await w.completions.listCompletedLectureIds(userId, COURSE)).toEqual([ARTICLE]);
  });

  it('the last two lectures completed in parallel: exactly one CourseCompleted (R1)', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'r1-course');
    const curriculum = curriculumOf([
      lecture(VIDEO, 'VIDEO'),
      lecture(ARTICLE, 'ARTICLE'),
      lecture(RESOURCE, 'RESOURCE'),
    ]);
    const [video, article, resource] = curriculum.sections[0]!.lectures as [
      ReturnType<typeof lecture>,
      ReturnType<typeof lecture>,
      ReturnType<typeof lecture>,
    ];
    await w.tx.run((trx) =>
      w.recorder.complete(trx, { userId, curriculum, lecture: video, cause: 'VIDEO_WATCHED' }),
    );
    await Promise.all([
      w.tx.run((trx) =>
        w.recorder.complete(trx, { userId, curriculum, lecture: article, cause: 'MANUAL' }),
      ),
      w.tx.run((trx) =>
        w.recorder.complete(trx, {
          userId,
          curriculum,
          lecture: resource,
          cause: 'RESOURCE_OPENED',
        }),
      ),
    ]);
    const types = await learningEventTypes(pg.db, userId);
    expect(types.filter((t) => t === 'LectureCompleted.v1')).toHaveLength(3);
    expect(types.filter((t) => t === 'CourseCompleted.v1')).toHaveLength(1);
    expect(await w.completions.findCourseCompletion(userId, COURSE)).not.toBeNull();

    // un-completing never removes the (append-only) course completion
    await w.tx.run((trx) =>
      w.recorder.clear(trx, { userId, courseId: COURSE, lectureId: ARTICLE }, new Date()),
    );
    expect(await w.completions.findCourseCompletion(userId, COURSE)).not.toBeNull();
    expect(await learningEventTypes(pg.db, userId)).toContain('LectureCompletionCleared.v1');
  });

  it('parallel heartbeats crossing 90 %: one LectureCompleted', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'r1-heartbeats');
    w.catalog.curricula.set(COURSE, curriculumOf([lecture(VIDEO, 'VIDEO'), lecture(QUIZ, 'QUIZ')]));
    await watch(w, userId, 0, 50);
    w.clock.advance(60);
    const results = await Promise.allSettled(
      [50, 55, 60, 65].map((from) =>
        w.heartbeat.execute({
          userId,
          courseId: COURSE,
          lectureId: VIDEO,
          positionSeconds: from + 40,
          ranges: [{ from, to: from + 40 }],
        }),
      ),
    );
    expect(results.some((r) => r.status === 'fulfilled' && r.value.lectureCompleted)).toBe(true);
    expect(
      (await learningEventTypes(pg.db, userId)).filter((t) => t === 'LectureCompleted.v1'),
    ).toHaveLength(1);
  });

  it('flushes what this replica buffered on SIGTERM (beforeApplicationShutdown)', async (ctx) => {
    skip(ctx);
    const w = wire();
    const userId = await learner(w, 'sigterm');
    const scheduler = new ProgressFlushScheduler(w.job, settings, new SchedulerRegistry());
    scheduler.onApplicationBootstrap();
    await watch(w, userId, 0, 20);
    await scheduler.beforeApplicationShutdown('SIGTERM');
    // The final flush is best effort (another holder of _06 drains it instead): finish here.
    if ((await w.progress.listCourseProgress(userId, COURSE)).length === 0) await flushAll(w);
    const [row] = await w.progress.listCourseProgress(userId, COURSE);
    expect(row).toMatchObject({ positionSeconds: 20, coveredBuckets: 4 });
  });
});
