import {
  CompletionStateSchema,
  ErrorCode,
  PlayerBootstrapSchema,
  ProgressAckSchema,
} from '@udemy/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors';
import {
  CompletionNotAllowed,
  CourseNotFound,
  EnrollmentRequired,
  LectureNotFound,
  LectureTypeMismatch,
  ProgressStoreUnavailable,
} from '../../domain/learning.errors';
import {
  ARTICLE,
  ASSET,
  COURSE,
  curriculumOf,
  FOREIGN_LECTURE,
  lecture,
  type LearningHarness,
  learningHarness,
  OTHER_STUDENT,
  OWNER,
  QUIZ,
  RESOURCE,
  REVISION,
  STUDENT,
  VIDEO,
} from '../testing/learning.fakes';

const UNKNOWN_COURSE = '01900000-0000-7000-8000-00000000c999';

/** One heartbeat of `seconds` played just now, after `seconds` of wall-clock time. */
async function watch(h: LearningHarness, from: number, to: number) {
  h.clock.advance(to - from);
  return h.heartbeat.execute({
    userId: STUDENT,
    courseId: COURSE,
    lectureId: VIDEO,
    positionSeconds: to,
    ranges: [{ from, to }],
  });
}

describe('RecordHeartbeat', () => {
  let h: LearningHarness;
  beforeEach(() => {
    h = learningHarness();
  });

  it('records coverage and position, and answers a contract-valid ack', async () => {
    const ack = await watch(h, 0, 30);
    expect(ProgressAckSchema.parse(ack)).toEqual({
      lectureCompleted: false,
      courseCompleted: false,
      coursePct: 0,
    });
    const buffered = await h.buffer.readBuffered(STUDENT, [
      { lectureId: VIDEO, mediaAssetId: ASSET, durationSeconds: 100 },
    ]);
    expect(buffered.get(VIDEO)).toEqual({
      positionSeconds: 30,
      coveredBuckets: 6,
      bucketCount: 20,
    });
    expect(h.rateLimiter.hits).toEqual([{ rule: 'heartbeat', subject: STUDENT }]);
    expect(h.buffer.dirty.has(`p:${STUDENT}:${VIDEO}`)).toBe(true);
  });

  it('completes the video synchronously at 90 % coverage, exactly once', async () => {
    await watch(h, 0, 45);
    const before = await watch(h, 45, 85); // 17 of 20 buckets
    expect(before.lectureCompleted).toBe(false);
    const ack = await watch(h, 85, 90); // 18 of 20 = 90 %
    expect(ack).toEqual({ lectureCompleted: true, courseCompleted: false, coursePct: 25 });
    expect(h.events.ofType('LectureCompleted')).toHaveLength(1);
    expect(h.events.ofType('LectureCompleted')[0]!.payload).toMatchObject({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
      lectureType: 'VIDEO',
      revisionId: REVISION,
      cause: 'VIDEO_WATCHED',
    });
    // further heartbeats keep the state and write nothing more
    const again = await watch(h, 90, 100);
    expect(again.lectureCompleted).toBe(true);
    expect(h.events.ofType('LectureCompleted')).toHaveLength(1);
    expect(h.tx.runs).toBe(1);
  });

  it('cannot be forged by seeking: ranges beyond the plausibility budget are dropped', async () => {
    h.clock.advance(1);
    const ack = await h.heartbeat.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
      positionSeconds: 100,
      ranges: [{ from: 0, to: 100 }], // 100 s on a first heartbeat (budget 60 s)
    });
    expect(ack.lectureCompleted).toBe(false);
    const buffered = await h.buffer.readBuffered(STUDENT, [
      { lectureId: VIDEO, mediaAssetId: ASSET, durationSeconds: 100 },
    ]);
    expect(buffered.get(VIDEO)?.coveredBuckets).toBe(0);
  });

  it('completes the course when the video was the last missing lecture', async () => {
    for (const [id, type, cause] of [
      [ARTICLE, 'ARTICLE', 'ARTICLE_READ'],
      [RESOURCE, 'RESOURCE', 'RESOURCE_OPENED'],
      [QUIZ, 'QUIZ', 'QUIZ_PASSED'],
    ] as const) {
      h.completions.seedCompletion(STUDENT, COURSE, id, type, cause);
    }
    await watch(h, 0, 50);
    const ack = await watch(h, 50, 90);
    expect(ack).toEqual({ lectureCompleted: true, courseCompleted: true, coursePct: 100 });
    expect(h.events.ofType('CourseCompleted')).toHaveLength(1);
    expect(h.events.ofType('CourseCompleted')[0]!.payload).toMatchObject({
      userId: STUDENT,
      courseId: COURSE,
      revisionId: REVISION,
      lectureCount: 4,
    });
  });

  it('404s an unknown course and a lecture of another course (IDOR)', async () => {
    await expect(
      h.heartbeat.execute({
        userId: STUDENT,
        courseId: UNKNOWN_COURSE,
        lectureId: VIDEO,
        positionSeconds: 0,
        ranges: [],
      }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    await expect(
      h.heartbeat.execute({
        userId: STUDENT,
        courseId: COURSE,
        lectureId: FOREIGN_LECTURE,
        positionSeconds: 0,
        ranges: [],
      }),
    ).rejects.toBeInstanceOf(LectureNotFound);
  });

  it('403s without an ACTIVE enrollment, the owner included, and caches the answer', async () => {
    for (const userId of [OTHER_STUDENT, OWNER]) {
      await expect(
        h.heartbeat.execute({
          userId,
          courseId: COURSE,
          lectureId: VIDEO,
          positionSeconds: 0,
          ranges: [],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.EnrollmentRequired });
    }
    expect(h.accessCache.values.get(`${OTHER_STUDENT}:${COURSE}`)).toBe(false);
    const calls = h.enrollment.calls;
    await expect(
      h.heartbeat.execute({
        userId: OTHER_STUDENT,
        courseId: COURSE,
        lectureId: VIDEO,
        positionSeconds: 0,
        ranges: [],
      }),
    ).rejects.toBeInstanceOf(EnrollmentRequired);
    expect(h.enrollment.calls).toBe(calls); // served by lrn:acc
  });

  it('honours a cached revocation within the cache window (fresh checks refresh it)', async () => {
    await watch(h, 0, 10);
    h.enrollment.active.clear(); // refunded
    await expect(watch(h, 10, 20)).resolves.toBeDefined(); // cached "1", ≤ 60 s
    await expect(h.bootstrap.execute({ userId: STUDENT, courseId: COURSE })).rejects.toBeInstanceOf(
      EnrollmentRequired,
    ); // fresh, rewrites the cache
    await expect(watch(h, 20, 30)).rejects.toBeInstanceOf(EnrollmentRequired);
  });

  it('422s a lecture that is not a video with a duration', async () => {
    await expect(
      h.heartbeat.execute({
        userId: STUDENT,
        courseId: COURSE,
        lectureId: ARTICLE,
        positionSeconds: 0,
        ranges: [],
      }),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);
  });

  it('429s once the limiter says so (the player drops the batch)', async () => {
    h.rateLimiter.limited.add('heartbeat');
    await expect(watch(h, 0, 10)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('503s when the buffer is down (the player keeps the batch)', async () => {
    h.buffer.failRecord = new ProgressStoreUnavailable();
    await expect(watch(h, 0, 10)).rejects.toBeInstanceOf(ProgressStoreUnavailable);
  });

  it('resets the bitmap when the live revision swapped the asset (D3)', async () => {
    await watch(h, 0, 45);
    await watch(h, 45, 85);
    const swapped = '01900000-0000-7000-8000-0000000aa009';
    h.catalog.curricula.set(
      COURSE,
      curriculumOf([lecture(VIDEO, 'VIDEO', { mediaAssetId: swapped, durationSeconds: 120 })]),
    );
    const ack = await watch(h, 85, 90);
    expect(ack.lectureCompleted).toBe(false);
    const buffered = await h.buffer.readBuffered(STUDENT, [
      { lectureId: VIDEO, mediaAssetId: swapped, durationSeconds: 120 },
    ]);
    expect(buffered.get(VIDEO)).toEqual({
      positionSeconds: 90,
      coveredBuckets: 1,
      bucketCount: 24,
    });
  });
});

describe('CompleteLecture / UncompleteLecture', () => {
  let h: LearningHarness;
  beforeEach(() => {
    h = learningHarness();
  });

  it('completes an article by ARTICLE_READ, idempotently, with one event', async () => {
    const first = await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: ARTICLE,
      cause: 'ARTICLE_READ',
    });
    expect(CompletionStateSchema.parse(first)).toMatchObject({
      lectureId: ARTICLE,
      completed: true,
      cause: 'ARTICLE_READ',
      progress: { completed: 1, total: 4, pct: 25 },
      courseCompletedAt: null,
    });
    const repeat = await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: ARTICLE,
      cause: 'MANUAL',
    });
    expect(repeat).toEqual(first);
    expect(h.events.ofType('LectureCompleted')).toHaveLength(1);
    expect(h.rateLimiter.hits.map((x) => x.rule)).toEqual(['completionToggle', 'completionToggle']);
    // the resume pointer follows
    expect(h.buffer.activity.get(`${STUDENT}:${COURSE}`)?.lectureId).toBe(ARTICLE);
  });

  it('refuses manual completion of a VIDEO or a QUIZ, and mismatching causes', async () => {
    for (const [lectureId, cause] of [
      [VIDEO, 'MANUAL'],
      [QUIZ, 'MANUAL'],
      [ARTICLE, 'RESOURCE_OPENED'],
      [RESOURCE, 'ARTICLE_READ'],
    ] as const) {
      await expect(
        h.complete.execute({ userId: STUDENT, courseId: COURSE, lectureId, cause }),
      ).rejects.toBeInstanceOf(CompletionNotAllowed);
    }
    expect(h.events.events).toHaveLength(0);
  });

  it('403s the owner preview and non-enrolled users on writes', async () => {
    for (const userId of [OWNER, OTHER_STUDENT]) {
      await expect(
        h.complete.execute({ userId, courseId: COURSE, lectureId: ARTICLE, cause: 'MANUAL' }),
      ).rejects.toBeInstanceOf(EnrollmentRequired);
      await expect(
        h.uncomplete.execute({ userId, courseId: COURSE, lectureId: ARTICLE }),
      ).rejects.toBeInstanceOf(EnrollmentRequired);
    }
  });

  it('completes the course on the last lecture; un-completing never revokes it (P5-D3)', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    h.completions.seedCompletion(STUDENT, COURSE, QUIZ, 'QUIZ', 'QUIZ_PASSED');
    await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: ARTICLE,
      cause: 'MANUAL',
    });
    const last = await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: RESOURCE,
      cause: 'RESOURCE_OPENED',
    });
    expect(last.progress).toEqual({ completed: 4, total: 4, pct: 100 });
    expect(last.courseCompletedAt).not.toBeNull();
    expect(h.events.ofType('CourseCompleted')).toHaveLength(1);

    const cleared = await h.uncomplete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: RESOURCE,
    });
    expect(cleared).toMatchObject({
      completed: false,
      cause: null,
      completedAt: null,
      progress: { completed: 3, total: 4, pct: 75 },
      courseCompletedAt: last.courseCompletedAt,
    });
    expect(h.events.ofType('LectureCompletionCleared')).toHaveLength(1);
    expect(h.events.ofType('LectureCompletionCleared')[0]!.payload).toMatchObject({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: RESOURCE,
    });
    // idempotent: nothing to clear, no second event
    await h.uncomplete.execute({ userId: STUDENT, courseId: COURSE, lectureId: RESOURCE });
    expect(h.events.ofType('LectureCompletionCleared')).toHaveLength(1);
    expect(h.completions.courseCompletions.size).toBe(1);
  });

  it('allows un-completing any type (a video included)', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    const state = await h.uncomplete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
    });
    expect(state.completed).toBe(false);
  });
});

describe('GetPlayerBootstrap', () => {
  let h: LearningHarness;
  beforeEach(() => {
    h = learningHarness();
  });

  it('LEARNER: annotates the live curriculum with completions, positions and coverage', async () => {
    await watch(h, 0, 30);
    await h.complete.execute({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: ARTICLE,
      cause: 'MANUAL',
    });
    h.completions.certificates.set(`${STUDENT}:${COURSE}`, {
      id: '01900000-0000-7000-8000-0000000cc001',
      code: '01J9ZP4X6V8Q2M3N5R7T9W0Y1A',
      status: 'ACTIVE',
    });
    const body = PlayerBootstrapSchema.parse(
      await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE }),
    );
    expect(body.mode).toBe('LEARNER');
    expect(body.instructor).toEqual({ id: OWNER, displayName: 'Ada Instructor' });
    const lectures = body.sections[0]!.lectures;
    expect(lectures.find((l) => l.id === VIDEO)).toMatchObject({
      completed: false,
      positionSeconds: 30,
      coveragePct: 30,
      durationSeconds: 100,
    });
    expect(lectures.find((l) => l.id === ARTICLE)).toMatchObject({
      completed: true,
      positionSeconds: null,
      coveragePct: null,
    });
    expect(lectures.find((l) => l.id === QUIZ)?.quiz).toEqual({ questionCount: 3, passPct: 70 });
    expect(body.progress).toEqual({ completed: 1, total: 4, pct: 25 });
    expect(body.resume).toEqual({ lectureId: ARTICLE, positionSeconds: null }); // newest activity
    expect(body.certificate?.status).toBe('ACTIVE');
    expect(body.completedAt).toBeNull();
    expect(body.newContent).toBe(false);
  });

  it('prefers the newer of the stored and the buffered resume pointers', async () => {
    h.progressRepo.activities.set(`${STUDENT}:${COURSE}`, {
      userId: STUDENT,
      courseId: COURSE,
      lectureId: RESOURCE,
      accessedAt: new Date(h.clock.ms + 60_000),
    });
    await watch(h, 0, 10);
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.resume?.lectureId).toBe(RESOURCE);
  });

  it('resumes at the first incomplete lecture without activity', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.resume).toEqual({ lectureId: ARTICLE, positionSeconds: null });
  });

  it('ignores stored progress of a swapped asset (D3)', async () => {
    await watch(h, 0, 30);
    await h.flushJob.flushOnce();
    h.buffer.entries.clear();
    h.catalog.curricula.set(
      COURSE,
      curriculumOf([
        lecture(VIDEO, 'VIDEO', { mediaAssetId: '01900000-0000-7000-8000-0000000aa009' }),
      ]),
    );
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.sections[0]!.lectures[0]).toMatchObject({
      positionSeconds: null,
      coveragePct: null,
    });
  });

  it('PREVIEW for the owner: every learner field empty, no writes', async () => {
    const body = PlayerBootstrapSchema.parse(
      await h.bootstrap.execute({ userId: OWNER, courseId: COURSE }),
    );
    expect(body).toMatchObject({
      mode: 'PREVIEW',
      progress: { completed: 0, total: 4, pct: 0 },
      resume: null,
      completedAt: null,
      newContent: false,
      certificate: null,
    });
    expect(
      body.sections[0]!.lectures.every((l) => !l.completed && l.positionSeconds === null),
    ).toBe(true);
    expect(h.tx.runs).toBe(0);
  });

  it('403s a non-enrolled user and 404s an unknown course', async () => {
    await expect(
      h.bootstrap.execute({ userId: OTHER_STUDENT, courseId: COURSE }),
    ).rejects.toBeInstanceOf(EnrollmentRequired);
    await expect(
      h.bootstrap.execute({ userId: STUDENT, courseId: UNKNOWN_COURSE }),
    ).rejects.toBeInstanceOf(CourseNotFound);
    await expect(h.bootstrap.execute({ userId: STUDENT, courseId: 'nope' })).rejects.toBeInstanceOf(
      CourseNotFound,
    );
  });

  it('lazily completes the course after a revision removed the last missing lecture (D5)', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    h.completions.seedCompletion(STUDENT, COURSE, ARTICLE, 'ARTICLE', 'MANUAL');
    h.catalog.curricula.set(
      COURSE,
      curriculumOf([lecture(VIDEO, 'VIDEO'), lecture(ARTICLE, 'ARTICLE')]),
    );
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.completedAt).not.toBeNull();
    expect(body.progress.pct).toBe(100);
    expect(h.events.ofType('CourseCompleted')).toHaveLength(1);
    // a second visit writes nothing
    await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(h.tx.runs).toBe(1);
  });

  it('keeps the completion when a later revision adds lectures ("New content")', async () => {
    h.completions.seedCompletion(STUDENT, COURSE, VIDEO, 'VIDEO', 'VIDEO_WATCHED');
    h.catalog.curricula.set(COURSE, curriculumOf([lecture(VIDEO, 'VIDEO')]));
    await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    h.catalog.curricula.set(COURSE, curriculumOf());
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.completedAt).not.toBeNull();
    expect(body.progress.pct).toBe(25);
    expect(body.newContent).toBe(true);
  });

  it('serves archived courses to their learners', async () => {
    h.catalog.curricula.set(COURSE, { ...curriculumOf(), status: 'ARCHIVED' });
    const body = await h.bootstrap.execute({ userId: STUDENT, courseId: COURSE });
    expect(body.status).toBe('ARCHIVED');
    expect(body.mode).toBe('LEARNER');
  });
});
