import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import { createUser } from '../testing/fixtures';
import {
  certificateCode,
  createCourseCompletion,
  startQuizAttempt,
  submitQuizAttempt,
} from '../testing/phase5-fixtures';
import {
  deferredFailure,
  deferredOk,
  deleteTestData,
  expectFailure,
  rollback,
  skipUnlessMigrated,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import { issueCertificate, recordCertificatePdf, transitionCertificate } from './certificates';
import { clearLectureCompletion, recordLectureCompletion } from './completion';
import { getLearningConsumption } from './consumption';
import { abandonStaleQuizAttempts, findCertificatesPendingPdf } from './maintenance';
import {
  getCourseActivity,
  getLectureCoverage,
  type LectureProgressInput,
  listCourseLectureProgress,
  upsertCourseActivity,
  upsertLectureProgress,
} from './progress';

/**
 * learning.* DDL invariants and the §8.1-§8.3/§8.7 SQL (docs/phase-5-schema-design.md §2, hand-off
 * item 5). Rolled back, except the parallel-completion race, which commits rows of users created
 * here (deleteTestData in afterAll). Never run in P5-T4 (Docker stopped): see the P5-T4 report.
 */
const pg = useIntegrationDb({ max: 6 });
const committedUsers: string[] = [];

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  await deleteTestData(pg.db, committedUsers);
});

type Trx = Transaction<DB>;

async function coverageText(trx: Trx, userId: string, lectureId: string) {
  const { rows } = await sql<{
    coverage: string;
    mediaAssetId: string;
    durationSeconds: number;
    positionSeconds: number;
    firstWatchedAt: Date;
    lastWatchedAt: Date;
  }>`
    SELECT coverage::text AS coverage, media_asset_id, duration_seconds, position_seconds, first_watched_at, last_watched_at
      FROM learning.lecture_progress WHERE user_id = ${userId} AND lecture_id = ${lectureId}
  `.execute(trx);
  return rows[0]!;
}

const t = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute, 0, 123));

describe('lecture_progress coverage (§8.1, D3)', () => {
  it('ORs same-asset bitmaps, pads/truncates to ceil(duration/5), keeps position last-write-wins', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const lecture = randomUUID();
      const course = randomUUID();
      const assetA = randomUUID();
      const base = (over: Partial<LectureProgressInput>): LectureProgressInput => ({
        userId: user,
        lectureId: lecture,
        courseId: course,
        mediaAssetId: assetA,
        durationSeconds: 61, // 13 buckets
        positionSeconds: 0,
        coverage: new Uint8Array(),
        firstWatchedAt: t(1),
        lastWatchedAt: t(1),
        ...over,
      });

      // 1 byte for 13 buckets: right-padded
      const [s1] = await upsertLectureProgress(trx, [
        base({ coverage: Uint8Array.from([0xf0]), positionSeconds: 20 }),
      ]);
      expect(s1).toMatchObject({ coveredBuckets: 4, bucketCount: 13, positionSeconds: 20 });
      expect((await coverageText(trx, user, lecture)).coverage).toBe('1111000000000');

      // newer, same asset: OR + position moves
      const [s2] = await upsertLectureProgress(trx, [
        base({ coverage: Uint8Array.from([0x0f]), positionSeconds: 40, lastWatchedAt: t(2) }),
      ]);
      expect(s2).toMatchObject({ coveredBuckets: 8, positionSeconds: 40 });
      expect((await coverageText(trx, user, lecture)).coverage).toBe('1111111100000');

      // OLDER batch, same asset: bits still OR in (commutative), position and last_watched_at stay
      await upsertLectureProgress(trx, [
        base({
          coverage: Uint8Array.from([0x00, 0x08]),
          positionSeconds: 5,
          firstWatchedAt: t(0),
          lastWatchedAt: t(0),
        }),
      ]);
      const s3 = await coverageText(trx, user, lecture);
      expect(s3).toMatchObject({ coverage: '1111111100001', positionSeconds: 40 });
      expect(s3.lastWatchedAt.getTime()).toBe(t(2).getTime());
      expect(s3.firstWatchedAt.getTime()).toBe(t(0).getTime());

      // 3 bytes for 13 buckets: truncated
      await upsertLectureProgress(trx, [
        base({ coverage: Uint8Array.from([0xff, 0xff, 0xff]), lastWatchedAt: t(3) }),
      ]);
      expect((await coverageText(trx, user, lecture)).coverage).toBe('1'.repeat(13));

      // NEWER heartbeat on another asset with another length: reset (no OR of unequal lengths)
      const assetB = randomUUID();
      const [s4] = await upsertLectureProgress(trx, [
        base({
          mediaAssetId: assetB,
          durationSeconds: 30,
          coverage: Uint8Array.from([0x80]),
          positionSeconds: 999,
          lastWatchedAt: t(4),
        }),
      ]);
      expect(s4).toMatchObject({
        mediaAssetId: assetB,
        durationSeconds: 30,
        positionSeconds: 30, // clamped to the duration
        coveredBuckets: 1,
        bucketCount: 6,
      });
      expect((await coverageText(trx, user, lecture)).coverage).toBe('100000');

      // OLDER heartbeat on yet another asset: ignored entirely (newer data wins)
      await upsertLectureProgress(trx, [
        base({
          mediaAssetId: randomUUID(),
          coverage: Uint8Array.from([0xff, 0xff]),
          lastWatchedAt: t(3),
        }),
      ]);
      expect(await coverageText(trx, user, lecture)).toMatchObject({
        coverage: '100000',
        mediaAssetId: assetB,
        durationSeconds: 30,
      });

      // Redis re-seed round trip and the course listing
      const cov = await getLectureCoverage(trx, user, lecture);
      expect(cov).toMatchObject({ bucketCount: 6, mediaAssetId: assetB });
      expect([...cov!.coverage]).toEqual([0x80]);
      const listed = await listCourseLectureProgress(trx, user, course);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ lectureId: lecture, coveredBuckets: 1, bucketCount: 6 });
    });
  });

  it('a multi-user batch merges every row; the coverage/position/time CHECKs reject malformed rows', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const [u1, u2] = [await createUser(trx), await createUser(trx)];
      const course = randomUUID();
      const lecture = randomUUID();
      const rows = [u2, u1].map((userId) => ({
        userId,
        lectureId: lecture,
        courseId: course,
        mediaAssetId: randomUUID(),
        durationSeconds: 10,
        positionSeconds: 3,
        coverage: Uint8Array.from([0xc0]),
        firstWatchedAt: t(1),
        lastWatchedAt: t(1),
      }));
      const out = await upsertLectureProgress(trx, rows);
      expect(out.map((r) => r.coveredBuckets)).toEqual([2, 2]);

      const user = await createUser(trx);
      for (const [label, values, constraint] of [
        [
          'wrong bitmap length',
          sql`(${user}, ${randomUUID()}, ${course}, ${randomUUID()}, 61, 0, B'101', now(), now())`,
          'lecture_progress_coverage_ck',
        ],
        [
          'position beyond duration',
          sql`(${user}, ${randomUUID()}, ${course}, ${randomUUID()}, 5, 6, B'1', now(), now())`,
          'lecture_progress_position_seconds_ck',
        ],
        [
          'last before first',
          sql`(${user}, ${randomUUID()}, ${course}, ${randomUUID()}, 5, 0, B'1', now(), now() - interval '1 s')`,
          'lecture_progress_times_ck',
        ],
      ] as const) {
        const err = await expectFailure(trx, () =>
          sql`
            INSERT INTO learning.lecture_progress (user_id, lecture_id, course_id, media_asset_id, duration_seconds,
                                                   position_seconds, coverage, first_watched_at, last_watched_at)
            VALUES ${values}`.execute(trx),
        );
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint,
        });
      }
      const moved = await expectFailure(trx, () =>
        sql`UPDATE learning.lecture_progress SET course_id = ${randomUUID()} WHERE user_id = ${u1}`.execute(
          trx,
        ),
      );
      expect(moved).toMatchObject({ code: '23514', constraint: 'lecture_progress_immutable_ck' });
    });
  });

  it('course_activity only moves forward', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      const [l1, l2] = [randomUUID(), randomUUID()];
      expect(
        await upsertCourseActivity(trx, [
          { userId: user, courseId: course, lectureId: l1, accessedAt: t(5) },
        ]),
      ).toBe(1);
      expect(
        await upsertCourseActivity(trx, [
          { userId: user, courseId: course, lectureId: l2, accessedAt: t(4) },
        ]),
      ).toBe(0);
      expect(await getCourseActivity(trx, user, course)).toMatchObject({ lastLectureId: l1 });
      expect(
        await upsertCourseActivity(trx, [
          { userId: user, courseId: course, lectureId: l2, accessedAt: t(6) },
        ]),
      ).toBe(1);
      expect(await getCourseActivity(trx, user, course)).toMatchObject({ lastLectureId: l2 });
    });
  });
});

describe('lecture and course completion (§8.2, D4/D5, R1)', () => {
  it('cause fits the type; QUIZ_PASSED needs a passed, submitted attempt; rows are insert/delete only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      const insert = (
        lectureId: string,
        type: string,
        cause: string,
        attempt: string | null = null,
      ) =>
        sql`
          INSERT INTO learning.lecture_completions (user_id, lecture_id, course_id, lecture_type, cause, revision_id, quiz_attempt_id)
          VALUES (${user}, ${lectureId}, ${course}, ${type}, ${cause}, ${randomUUID()}, ${attempt})`.execute(
          trx,
        );

      const manualVideo = await expectFailure(trx, () => insert(randomUUID(), 'VIDEO', 'MANUAL'));
      expect(manualVideo).toMatchObject({
        code: '23514',
        constraint: 'lecture_completions_cause_type_ck',
      });
      const noAttempt = await expectFailure(trx, () => insert(randomUUID(), 'QUIZ', 'QUIZ_PASSED'));
      expect(noAttempt).toMatchObject({
        code: '23514',
        constraint: 'lecture_completions_quiz_attempt_ck',
      });

      const quizLecture = randomUUID();
      const failed = await startQuizAttempt(trx, {
        userId: user,
        courseId: course,
        lectureId: quizLecture,
        questionIds: [randomUUID(), randomUUID()],
      });
      await submitQuizAttempt(trx, failed, [false, false]);
      const notPassed = await expectFailure(trx, () =>
        insert(quizLecture, 'QUIZ', 'QUIZ_PASSED', failed),
      );
      expect(notPassed).toMatchObject({
        code: '23514',
        constraint: 'lecture_completions_quiz_passed_ck',
      });

      const passed = await startQuizAttempt(trx, {
        userId: user,
        courseId: course,
        lectureId: quizLecture,
        questionIds: [randomUUID(), randomUUID()],
      });
      await submitQuizAttempt(trx, passed, [true, true]);
      await insert(quizLecture, 'QUIZ', 'QUIZ_PASSED', passed);

      const frozen = await expectFailure(trx, () =>
        sql`UPDATE learning.lecture_completions SET cause = 'QUIZ_PASSED' WHERE lecture_id = ${quizLecture}`.execute(
          trx,
        ),
      );
      expect(frozen).toMatchObject({
        code: '23514',
        constraint: 'lecture_completions_immutable_ck',
      });
    });
  });

  it('records idempotently, completes the course once the live set is covered, and never undoes it', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      const revision = randomUUID();
      const [l1, l2] = [randomUUID(), randomUUID()];
      const input = (lectureId: string) => ({
        userId: user,
        courseId: course,
        lectureId,
        lectureType: 'ARTICLE' as const,
        cause: 'MANUAL' as const,
        revisionId: revision,
        liveLectureIds: [l1, l2],
      });
      const first = await recordLectureCompletion(trx, input(l1));
      expect(first.lecture).not.toBeNull();
      expect(first.course).toMatchObject({
        completedLectures: 1,
        totalLectures: 2,
        completion: null,
      });
      const again = await recordLectureCompletion(trx, input(l1));
      expect(again.lecture).toBeNull();
      const last = await recordLectureCompletion(trx, input(l2));
      expect(last.course.completion).toMatchObject({ newlyCompleted: true });
      expect(
        await clearLectureCompletion(trx, { userId: user, courseId: course, lectureId: l2 }),
      ).toEqual({
        lectureType: 'ARTICLE',
        cause: 'MANUAL',
      });
      const after = await recordLectureCompletion(trx, input(l1));
      expect(after.course).toMatchObject({
        completedLectures: 1,
        completion: { newlyCompleted: false },
      });
      const del = await expectFailure(trx, () =>
        sql`DELETE FROM learning.course_completions WHERE user_id = ${user}`.execute(trx),
      );
      expect(del.code).toBe('42501');
    });
  });

  it('R1: completing the last two lectures in parallel yields exactly one course completion', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const user = await createUser(pg.db);
    committedUsers.push(user);
    const course = randomUUID();
    const revision = randomUUID();
    const lectures = [randomUUID(), randomUUID(), randomUUID()];
    await pg.db.transaction().execute((trx) =>
      recordLectureCompletion(trx, {
        userId: user,
        courseId: course,
        lectureId: lectures[0]!,
        lectureType: 'RESOURCE',
        cause: 'RESOURCE_OPENED',
        revisionId: revision,
        liveLectureIds: lectures,
      }),
    );
    const results = await Promise.all(
      [lectures[1]!, lectures[2]!].map((lectureId) =>
        pg.db.transaction().execute((trx) =>
          recordLectureCompletion(trx, {
            userId: user,
            courseId: course,
            lectureId,
            lectureType: 'ARTICLE',
            cause: 'ARTICLE_READ',
            revisionId: revision,
            liveLectureIds: lectures,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.course.completion?.newlyCompleted === true)).toHaveLength(1);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM learning.course_completions WHERE user_id = ${user} AND course_id = ${course}
    `.execute(pg.db);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('quiz attempts (D6)', () => {
  it('one open attempt per quiz; terminal states frozen; questions only in the start tx; selections only while open', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const lecture = randomUUID();
      const q = [randomUUID(), randomUUID()];
      const a1 = await startQuizAttempt(trx, { userId: user, lectureId: lecture, questionIds: q });
      const second = await expectFailure(trx, () =>
        startQuizAttempt(trx, { userId: user, lectureId: lecture, questionIds: q }),
      );
      expect(second).toMatchObject({
        code: '23505',
        constraint: 'quiz_attempts_user_id_lecture_id_open_uq',
      });

      await sql`INSERT INTO learning.quiz_attempt_selections (attempt_id, question_id, option_position) VALUES (${a1}, ${q[0]}, 1)`.execute(
        trx,
      );
      await submitQuizAttempt(trx, a1, [true, false]);
      const closed = await expectFailure(trx, () =>
        sql`INSERT INTO learning.quiz_attempt_selections (attempt_id, question_id, option_position) VALUES (${a1}, ${q[1]}, 0)`.execute(
          trx,
        ),
      );
      expect(closed).toMatchObject({
        code: '23514',
        constraint: 'quiz_attempt_selections_attempt_open_ck',
      });
      const reopen = await expectFailure(trx, () =>
        sql`UPDATE learning.quiz_attempts SET status = 'ABANDONED', abandoned_at = now() WHERE id = ${a1}`.execute(
          trx,
        ),
      );
      expect(reopen).toMatchObject({ code: '23514', constraint: 'quiz_attempts_transition_ck' });
      const regrade = await expectFailure(trx, () =>
        sql`UPDATE learning.quiz_attempt_questions SET is_correct = true WHERE attempt_id = ${a1} AND question_id = ${q[1]}`.execute(
          trx,
        ),
      );
      expect(regrade).toMatchObject({
        code: '23514',
        constraint: 'quiz_attempt_questions_immutable_ck',
      });

      // an attempt started in an earlier transaction (simulated: started_at in the past) cannot gain questions
      const { rows } = await sql<{ id: string }>`
        INSERT INTO learning.quiz_attempts (user_id, course_id, lecture_id, revision_id, pass_pct, question_count, started_at)
        VALUES (${user}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 70, 1, now() - interval '1 minute')
        RETURNING id`.execute(trx);
      const late = await expectFailure(trx, () =>
        sql`INSERT INTO learning.quiz_attempt_questions (attempt_id, question_id, position) VALUES (${rows[0]!.id}, ${randomUUID()}, 0)`.execute(
          trx,
        ),
      );
      expect(late).toMatchObject({
        code: '23514',
        constraint: 'quiz_attempt_questions_same_tx_ck',
      });
    });
  });

  it('correct_count must match the graded questions at COMMIT (quiz_attempts_grading_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const err = await deferredFailure(pg.db, async (trx) => {
      const user = await createUser(trx);
      const a = await startQuizAttempt(trx, {
        userId: user,
        questionIds: [randomUUID(), randomUUID()],
      });
      await sql`UPDATE learning.quiz_attempt_questions SET is_correct = true WHERE attempt_id = ${a}`.execute(
        trx,
      );
      await sql`UPDATE learning.quiz_attempts SET status = 'SUBMITTED', submitted_at = now(), correct_count = 1 WHERE id = ${a}`.execute(
        trx,
      );
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'quiz_attempts_grading_ck' });
    const missing = await deferredFailure(pg.db, async (trx) => {
      const user = await createUser(trx);
      await sql`
        INSERT INTO learning.quiz_attempts (user_id, course_id, lecture_id, revision_id, pass_pct, question_count)
        VALUES (${user}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 70, 3)`.execute(trx);
    });
    expect(missing).toMatchObject({ code: '23514', constraint: 'quiz_attempts_grading_ck' });
  });

  it('LearningMaintenanceJob abandons stale IN_PROGRESS attempts only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO learning.quiz_attempts (user_id, course_id, lecture_id, revision_id, pass_pct, question_count, started_at)
        VALUES (${user}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 70, 1, now() - interval '25 hours')
        RETURNING id`.execute(trx);
      const fresh = await startQuizAttempt(trx, { userId: user, questionIds: [randomUUID()] });
      const abandoned = await abandonStaleQuizAttempts(trx, { ttlHours: 24 });
      expect(abandoned).toContain(rows[0]!.id);
      expect(abandoned).not.toContain(fresh);
      const { rows: st } = await sql<{
        status: string;
      }>`SELECT status FROM learning.quiz_attempts WHERE id = ${rows[0]!.id}`.execute(trx);
      expect(st[0]!.status).toBe('ABANDONED');
    });
  });
});

async function issued(trx: Trx, user: string): Promise<{ id: string; course: string }> {
  const course = randomUUID();
  await createCourseCompletion(trx, { userId: user, courseId: course });
  const r = await issueCertificate(trx, {
    userId: user,
    courseId: course,
    revisionId: randomUUID(),
    publicCode: certificateCode(),
    recipientName: 'Ada Lovelace',
    courseTitle: 'Integration course',
    instructorName: 'Grace Hopper',
    sourceEventId: randomUUID(),
  });
  if (r.outcome !== 'ISSUED') throw new Error(`unexpected ${r.outcome}`);
  return { id: r.certificateId, course };
}

describe('certificates (D7, R6, R13)', () => {
  it('issue -> enrollment revoke -> regrant reinstate is consistent at COMMIT; the PDF is recorded once', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const user = await createUser(trx);
      const c = await issued(trx, user);
      const dup = await issueCertificate(trx, {
        userId: user,
        courseId: c.course,
        revisionId: randomUUID(),
        publicCode: certificateCode(),
        recipientName: 'Ada Lovelace',
        courseTitle: 'Integration course',
        instructorName: 'Grace Hopper',
        sourceEventId: randomUUID(),
      });
      expect(dup).toEqual({ outcome: 'EXISTS', certificateId: c.id, pdfRenderedAt: null });
      expect(
        await transitionCertificate(trx, {
          certificateId: c.id,
          action: 'REVOKE',
          cause: 'ENROLLMENT_REVOKED',
          sourceEventId: randomUUID(),
        }),
      ).toMatchObject({ outcome: 'APPLIED', seq: 2, status: 'REVOKED' });
      expect(
        await transitionCertificate(trx, {
          certificateId: c.id,
          action: 'REVOKE',
          cause: 'ENROLLMENT_REVOKED',
          sourceEventId: randomUUID(),
        }),
      ).toEqual({ outcome: 'NOOP', status: 'REVOKED' });
      expect(
        await transitionCertificate(trx, {
          certificateId: c.id,
          action: 'REINSTATE',
          cause: 'ENROLLMENT_REGRANTED',
          sourceEventId: randomUUID(),
        }),
      ).toMatchObject({ outcome: 'APPLIED', seq: 3, status: 'ACTIVE' });
      expect(await recordCertificatePdf(trx, c.id)).toBe(true);
      expect(await recordCertificatePdf(trx, c.id)).toBe(false);
      const moved = await expectFailure(trx, () =>
        sql`UPDATE learning.certificates SET pdf_rendered_at = now() + interval '1 s' WHERE id = ${c.id}`.execute(
          trx,
        ),
      );
      expect(moved).toMatchObject({ code: '23514', constraint: 'certificates_immutable_ck' });
    });
  });

  it('an admin revoke sticks: the regrant is skipped, and a forced reinstate fails at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const user = await createUser(trx);
      const admin = await createUser(trx);
      const c = await issued(trx, user);
      await transitionCertificate(trx, {
        certificateId: c.id,
        action: 'REVOKE',
        cause: 'ADMIN',
        actorId: admin,
        reason: 'Plagiarised final project',
      });
      expect(
        await transitionCertificate(trx, {
          certificateId: c.id,
          action: 'REINSTATE',
          cause: 'ENROLLMENT_REGRANTED',
          sourceEventId: randomUUID(),
        }),
      ).toEqual({ outcome: 'SKIPPED_ADMIN_REVOKE', status: 'REVOKED' });
    });
    const forced = await deferredFailure(pg.db, async (trx) => {
      const user = await createUser(trx);
      const admin = await createUser(trx);
      const c = await issued(trx, user);
      await transitionCertificate(trx, {
        certificateId: c.id,
        action: 'REVOKE',
        cause: 'ADMIN',
        actorId: admin,
        reason: 'Plagiarised final project',
      });
      await sql`
        INSERT INTO learning.certificate_transitions (certificate_id, seq, action, from_status, to_status, cause, source_event_id)
        VALUES (${c.id}, 3, 'REINSTATE', 'REVOKED', 'ACTIVE', 'ENROLLMENT_REGRANTED', ${randomUUID()})`.execute(
        trx,
      );
      await sql`UPDATE learning.certificates SET status = 'ACTIVE', revoked_at = NULL WHERE id = ${c.id}`.execute(
        trx,
      );
    });
    expect(forced).toMatchObject({
      code: '23514',
      constraint: 'certificate_transitions_reinstate_cause_ck',
    });
  });

  it('status without a transition, a second ISSUE and an admin action without a reason are rejected', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const noLog = await deferredFailure(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      await createCourseCompletion(trx, { userId: user, courseId: course });
      await sql`
        INSERT INTO learning.certificates (public_code, user_id, course_id, revision_id, recipient_name, course_title,
                                           instructor_name, source_event_id)
        VALUES (${certificateCode()}, ${user}, ${course}, ${randomUUID()}, 'Ada', 'Course', 'Grace', ${randomUUID()})`.execute(
        trx,
      );
    });
    expect(noLog).toMatchObject({ code: '23514', constraint: 'certificates_status_log_ck' });

    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const admin = await createUser(trx);
      const c = await issued(trx, user);
      const reissue = await expectFailure(trx, () =>
        sql`
          INSERT INTO learning.certificate_transitions (certificate_id, seq, action, from_status, to_status, cause, source_event_id)
          VALUES (${c.id}, 2, 'ISSUE', NULL, 'ACTIVE', 'COURSE_COMPLETED', ${randomUUID()})`.execute(
          trx,
        ),
      );
      expect(reissue).toMatchObject({
        code: '23514',
        constraint: 'certificate_transitions_root_ck',
      });
      const noReason = await expectFailure(trx, () =>
        sql`
          INSERT INTO learning.certificate_transitions (certificate_id, seq, action, from_status, to_status, cause, actor_id)
          VALUES (${c.id}, 2, 'REVOKE', 'ACTIVE', 'REVOKED', 'ADMIN', ${admin})`.execute(trx),
      );
      expect(noReason).toMatchObject({
        code: '23514',
        constraint: 'certificate_transitions_reason_ck',
      });
      const wrongFrom = await expectFailure(trx, () =>
        sql`
          INSERT INTO learning.certificate_transitions (certificate_id, seq, action, from_status, to_status, cause, source_event_id)
          VALUES (${c.id}, 2, 'REINSTATE', 'REVOKED', 'ACTIVE', 'ENROLLMENT_REGRANTED', ${randomUUID()})`.execute(
          trx,
        ),
      );
      expect(wrongFrom).toMatchObject({
        code: '23503',
        constraint: 'certificate_transitions_certificate_id_prev_seq_from_status_fk',
      });
      const noCompletion = await expectFailure(trx, () =>
        issueCertificate(trx, {
          userId: user,
          courseId: randomUUID(),
          revisionId: randomUUID(),
          publicCode: certificateCode(),
          recipientName: 'Ada',
          courseTitle: 'Course',
          instructorName: 'Grace',
          sourceEventId: randomUUID(),
        }),
      );
      expect(noCompletion).toMatchObject({
        code: '23503',
        constraint: 'certificates_user_id_course_id_fk',
      });
    });
  });

  it('pending-PDF lookup finds certificates without a PDF older than the threshold', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      await createCourseCompletion(trx, { userId: user, courseId: course });
      const { rows } = await sql<{ id: string }>`
        INSERT INTO learning.certificates (public_code, user_id, course_id, revision_id, recipient_name, course_title,
                                           instructor_name, source_event_id, issued_at)
        VALUES (${certificateCode()}, ${user}, ${course}, ${randomUUID()}, 'Ada', 'Course', 'Grace', ${randomUUID()},
                now() - interval '1 hour')
        RETURNING id`.execute(trx);
      const fresh = await issued(trx, user);
      const pending = await findCertificatesPendingPdf(trx, { olderThanMinutes: 10, limit: 1000 });
      expect(pending).toContain(rows[0]!.id);
      expect(pending).not.toContain(fresh.id);
    });
  });
});

describe('consumption for the refund policy (§8.3)', () => {
  it('counts only bitmaps of the live asset+duration, clamps the last bucket, and reads completions/certificate', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      const [v1, v2, v3, art] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const [a1, a2, a3, old] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const p = (
        lectureId: string,
        mediaAssetId: string,
        durationSeconds: number,
        coverage: number[],
      ) => ({
        userId: user,
        lectureId,
        courseId: course,
        mediaAssetId,
        durationSeconds,
        positionSeconds: 0,
        coverage: Uint8Array.from(coverage),
        firstWatchedAt: t(1),
        lastWatchedAt: t(1),
      });
      await upsertLectureProgress(trx, [
        p(v1, a1, 60, [0xfc]), // 6 of 12 buckets = 30 s
        p(v2, old, 100, [0xff, 0xff]), // measured against a replaced asset: ignored
        p(v3, a3, 7, [0xc0]), // 2 buckets = 10 s, clamped to 7 s
      ]);
      await recordLectureCompletion(trx, {
        userId: user,
        courseId: course,
        lectureId: art,
        lectureType: 'ARTICLE',
        cause: 'ARTICLE_READ',
        revisionId: randomUUID(),
        liveLectureIds: [v1, v2, v3, art],
      });
      const c = await getLearningConsumption(trx, {
        userId: user,
        courseId: course,
        lectures: [
          { lectureId: v1, type: 'VIDEO', mediaAssetId: a1, durationSeconds: 60 },
          { lectureId: v2, type: 'VIDEO', mediaAssetId: a2, durationSeconds: 100 },
          { lectureId: v3, type: 'VIDEO', mediaAssetId: a3, durationSeconds: 7 },
          { lectureId: art, type: 'ARTICLE', mediaAssetId: null, durationSeconds: null },
        ],
      });
      expect(c).toEqual({
        videoSecondsWatched: 37,
        videoSecondsTotal: 167,
        completedLectures: 1,
        totalLectures: 4,
        courseCompletedAt: null,
        certificateStatus: null,
      });
    });
  });
});

describe('append-only and insert/delete-only learning tables', () => {
  it('UPDATE/DELETE on history tables fail with 42501; TRUNCATE is blocked everywhere', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const user = await createUser(trx);
      const c = await issued(trx, user);
      const q = randomUUID();
      const a = await startQuizAttempt(trx, { userId: user, questionIds: [q] });
      await sql`INSERT INTO learning.quiz_attempt_selections (attempt_id, question_id, option_position) VALUES (${a}, ${q}, 0)`.execute(
        trx,
      );
      const attempts: [string, () => Promise<unknown>][] = [
        [
          'update course_completions',
          () =>
            sql`UPDATE learning.course_completions SET lecture_count = 2 WHERE user_id = ${user}`.execute(
              trx,
            ),
        ],
        [
          'delete course_completions',
          () => sql`DELETE FROM learning.course_completions WHERE user_id = ${user}`.execute(trx),
        ],
        [
          'update certificate_transitions',
          () =>
            sql`UPDATE learning.certificate_transitions SET cause = 'ADMIN' WHERE certificate_id = ${c.id}`.execute(
              trx,
            ),
        ],
        [
          'delete certificate_transitions',
          () =>
            sql`DELETE FROM learning.certificate_transitions WHERE certificate_id = ${c.id}`.execute(
              trx,
            ),
        ],
        [
          'update quiz_attempt_selections',
          () =>
            sql`UPDATE learning.quiz_attempt_selections SET option_position = 1 WHERE attempt_id = ${a}`.execute(
              trx,
            ),
        ],
        [
          'delete quiz_attempt_selections',
          () =>
            sql`DELETE FROM learning.quiz_attempt_selections WHERE attempt_id = ${a}`.execute(trx),
        ],
        [
          'delete quiz_attempt_questions',
          () =>
            sql`DELETE FROM learning.quiz_attempt_questions WHERE attempt_id = ${a}`.execute(trx),
        ],
      ];
      for (const [label, run] of attempts) {
        const err = await expectFailure(trx, run);
        expect({ label, code: err.code }).toEqual({ label, code: '42501' });
      }
    });
    // TRUNCATE needs a transaction with no pending trigger events on the table (else 55006);
    // FK targets need CASCADE to get past 0A000 and reach the trigger.
    for (const statement of [
      'TRUNCATE learning.course_completions CASCADE',
      'TRUNCATE learning.certificate_transitions',
      'TRUNCATE learning.certificates CASCADE',
      'TRUNCATE learning.quiz_attempt_selections',
      'TRUNCATE learning.quiz_attempt_questions CASCADE',
      'TRUNCATE learning.quiz_attempts CASCADE',
    ]) {
      await rollback(pg.db, async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        const err = await expectFailure(trx, () => sql.raw(statement).execute(trx));
        expect({ statement, code: err.code }).toEqual({ statement, code: '42501' });
      });
    }
  });
});
