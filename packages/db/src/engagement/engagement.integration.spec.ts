import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createUser } from '../testing/fixtures';
import { createAnswer, createQuestion, createReviewRow } from '../testing/phase5-fixtures';
import {
  deferredFailure,
  deferredOk,
  deleteTestData,
  expectFailure,
  rollback,
  skipUnlessMigrated,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import {
  findAnswerCounterDrift,
  findQuestionCounterDrift,
  findRatingStatsDrift,
} from './consistency';
import { moderateSubject, reportContent } from './moderation';
import { castVote, listQuestions, retractVote } from './qa';
import { getCourseRatings, recomputeCourseRating, upsertReview } from './reviews';

/**
 * engagement.* invariants (docs/phase-5-schema-design.md §2, §6 R7-R11, §8.4-§8.5, §8.8).
 * The race tests commit rows of users created here (deleteTestData in afterAll; rating rows are
 * removed by course id). Never run in P5-T4 (Docker stopped).
 */
const PARALLEL = 20;
const pg = useIntegrationDb({ max: PARALLEL + 4 });
const committedUsers: string[] = [];
const committedCourses: string[] = [];

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  if (committedCourses.length > 0) {
    await sql`DELETE FROM engagement.course_rating_stats WHERE course_id = ANY(${committedCourses}::uuid[])`.execute(
      pg.db,
    );
  }
  await deleteTestData(pg.db, committedUsers);
});

async function users(n: number): Promise<string[]> {
  const ids = await Promise.all(Array.from({ length: n }, () => createUser(pg.db)));
  committedUsers.push(...ids);
  return ids;
}

function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as Error & { code?: string } }),
  );
}

describe('Q&A counters under concurrency (R7, R8, P5-D12)', () => {
  it(`${PARALLEL} parallel votes by one user count once; ${PARALLEL} users count ${PARALLEL}; retracts are exact`, async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const [author, voter] = await users(2);
    const course = randomUUID();
    const q = await createQuestion(pg.db, { authorId: author!, courseId: course });
    const same = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        castVote(pg.db, { subject: 'QUESTION', subjectId: q, userId: voter! }),
      ),
    );
    expect(same.filter(Boolean)).toHaveLength(1);
    const voters = await users(PARALLEL);
    const results = await Promise.all(
      voters.map((userId) => castVote(pg.db, { subject: 'QUESTION', subjectId: q, userId })),
    );
    expect(results.every(Boolean)).toBe(true);
    await Promise.all(
      voters
        .slice(0, 5)
        .map((userId) => retractVote(pg.db, { subject: 'QUESTION', subjectId: q, userId })),
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT upvote_count AS n FROM engagement.questions WHERE id = ${q}`.execute(pg.db);
    expect(rows[0]!.n).toBe(1 + PARALLEL - 5);
    expect(await findQuestionCounterDrift(pg.db, { courseIds: [course] })).toEqual([]);
  });

  it('parallel answers give the exact answer_count and last_activity_at; answer votes stay exact', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const [author] = await users(1);
    const answerers = await users(10);
    const course = randomUUID();
    const q = await createQuestion(pg.db, { authorId: author!, courseId: course });
    const answers = await Promise.all(
      answerers.map((a) => createAnswer(pg.db, { questionId: q, authorId: a })),
    );
    await Promise.all(
      answerers.map((voter) =>
        castVote(pg.db, { subject: 'ANSWER', subjectId: answers[0]!, userId: voter }).catch(
          (e: { constraint?: string }) => {
            // the first answer's author cannot vote on it
            if (e.constraint !== 'answer_votes_own_content_ck') throw e;
            return false;
          },
        ),
      ),
    );
    const { rows } = await sql<{ n: number; votes: number }>`
      SELECT q.answer_count AS n, a.upvote_count AS votes
        FROM engagement.questions q JOIN engagement.answers a ON a.id = ${answers[0]!}
       WHERE q.id = ${q}`.execute(pg.db);
    expect(rows[0]).toEqual({ n: 10, votes: 9 });
    expect(await findQuestionCounterDrift(pg.db, { courseIds: [course] })).toEqual([]);
    expect(await findAnswerCounterDrift(pg.db, { questionIds: [q] })).toEqual([]);
  });

  it('hiding or deleting the accepted answer clears it; the app cannot write counters; own votes are rejected', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const author = await createUser(trx);
      const helper = await createUser(trx);
      const admin = await createUser(trx);
      const course = randomUUID();
      const q = await createQuestion(trx, { authorId: author, courseId: course });
      const a1 = await createAnswer(trx, { questionId: q, authorId: helper });
      const a2 = await createAnswer(trx, { questionId: q, authorId: helper });
      await sql`UPDATE engagement.questions SET accepted_answer_id = ${a1} WHERE id = ${q}`.execute(
        trx,
      );
      await moderateSubject(trx, {
        subjectType: 'ANSWER',
        subjectId: a1,
        action: 'HIDE',
        actorId: admin,
        reason: 'Off-topic advertisement',
      });
      const after = await sql<{ accepted: string | null; n: number }>`
        SELECT accepted_answer_id AS accepted, answer_count AS n FROM engagement.questions WHERE id = ${q}`.execute(
        trx,
      );
      expect(after.rows[0]).toEqual({ accepted: null, n: 1 });
      const hidden = await expectFailure(trx, () =>
        sql`UPDATE engagement.questions SET accepted_answer_id = ${a1} WHERE id = ${q}`.execute(
          trx,
        ),
      );
      expect(hidden).toMatchObject({
        code: '23514',
        constraint: 'questions_accepted_answer_visible_ck',
      });
      await sql`UPDATE engagement.questions SET accepted_answer_id = ${a2} WHERE id = ${q}`.execute(
        trx,
      );
      await sql`UPDATE engagement.answers SET deleted_at = now() WHERE id = ${a2}`.execute(trx);
      const cleared = await sql<{ accepted: string | null; n: number }>`
        SELECT accepted_answer_id AS accepted, answer_count AS n FROM engagement.questions WHERE id = ${q}`.execute(
        trx,
      );
      expect(cleared.rows[0]).toEqual({ accepted: null, n: 0 });
      const otherQ = await createQuestion(trx, { authorId: author, courseId: course });
      const foreign = await expectFailure(trx, () =>
        sql`UPDATE engagement.questions SET accepted_answer_id = ${a1} WHERE id = ${otherQ}`.execute(
          trx,
        ),
      );
      // the BEFORE trigger reports it before the composite FK (questions_id_accepted_answer_id_fk) would
      expect(foreign).toMatchObject({
        code: '23514',
        constraint: 'questions_accepted_answer_visible_ck',
      });

      for (const [label, statement, constraint] of [
        [
          'question upvotes',
          sql`UPDATE engagement.questions SET upvote_count = 3 WHERE id = ${q}`,
          'questions_counters_ck',
        ],
        [
          'question answers',
          sql`UPDATE engagement.questions SET answer_count = 3 WHERE id = ${q}`,
          'questions_counters_ck',
        ],
        [
          'answer upvotes',
          sql`UPDATE engagement.answers SET upvote_count = 3 WHERE id = ${a1}`,
          'answers_counters_ck',
        ],
        [
          'insert with counters',
          sql`INSERT INTO engagement.questions (course_id, author_id, title, body_md, upvote_count) VALUES (${course}, ${author}, 'Cheating question', 'x', 9)`,
          'questions_counters_ck',
        ],
        [
          'own vote',
          sql`INSERT INTO engagement.question_votes (subject_id, user_id) VALUES (${q}, ${author})`,
          'question_votes_own_content_ck',
        ],
        [
          'own report',
          sql`INSERT INTO engagement.question_reports (subject_id, reporter_id, reason) VALUES (${q}, ${author}, 'SPAM')`,
          'question_reports_own_content_ck',
        ],
      ] as const) {
        const err = await expectFailure(trx, () => statement.execute(trx));
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint,
        });
      }
      expect(await findQuestionCounterDrift(trx, { courseIds: [course] })).toEqual([]);
    });
  });

  it('listQuestions pages by (last_activity_at, id) with microsecond cursors', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const author = await createUser(trx);
      const course = randomUUID();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        // one transaction: every last_activity_at is the same now(); the id breaks the ties
        ids.push(
          await createQuestion(trx, {
            authorId: author,
            courseId: course,
            title: `Question number ${i}`,
          }),
        );
      }
      const page1 = await listQuestions(trx, { courseId: course, sort: 'recent', limit: 2 });
      const page2 = await listQuestions(trx, {
        courseId: course,
        sort: 'recent',
        limit: 2,
        after: page1[1]!.cursor,
      });
      const page3 = await listQuestions(trx, {
        courseId: course,
        sort: 'recent',
        limit: 2,
        after: page2[1]!.cursor,
      });
      const seen = [...page1, ...page2, ...page3].map((r) => r.id);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...ids].sort());
      const search = await listQuestions(trx, {
        courseId: course,
        sort: 'unanswered',
        limit: 10,
        titleContains: 'number 3',
      });
      expect(search.map((r) => r.id)).toEqual([ids[3]]);
    });
  });
});

describe('rating recompute = §8.8 consistency query (D11, R11)', () => {
  it('after mixed review operations the recomputed histogram equals a fresh count', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const course = randomUUID();
      const admin = await createUser(trx);
      const reviewers = await Promise.all(Array.from({ length: 8 }, () => createUser(trx)));
      const ids: string[] = [];
      for (const [i, u] of reviewers.entries()) {
        ids.push(
          (
            await upsertReview(trx, {
              courseId: course,
              userId: u,
              rating: (i % 5) + 1,
              body: null,
            })
          ).reviewId,
        );
      }
      await upsertReview(trx, {
        courseId: course,
        userId: reviewers[0]!,
        rating: 5,
        body: 'Changed my mind',
      }); // edit 1 -> 5
      await sql`UPDATE engagement.reviews SET deleted_at = now(), deleted_by = ${reviewers[1]} WHERE id = ${ids[1]}`.execute(
        trx,
      ); // delete a 2
      await sql`UPDATE engagement.reviews SET suspended_at = now() WHERE id = ${ids[2]}`.execute(
        trx,
      ); // suspend a 3
      await moderateSubject(trx, {
        subjectType: 'REVIEW',
        subjectId: ids[3]!,
        action: 'HIDE',
        actorId: admin,
        reason: 'Abusive language here',
      }); // hide a 4
      const r = await recomputeCourseRating(trx, course);
      // published: [5 (edited), 5, 1, 2, 3] -> counts 1:1 2:1 3:1 4:0 5:2
      expect(r).toMatchObject({ reviewCount: 5, counts: [1, 1, 1, 0, 2], average: '3.2' });
      expect(await findRatingStatsDrift(trx, { courseIds: [course] })).toEqual([]);
      await moderateSubject(trx, {
        subjectType: 'REVIEW',
        subjectId: ids[3]!,
        action: 'RESTORE',
        actorId: admin,
        reason: 'Reviewed again: acceptable',
      });
      expect(await findRatingStatsDrift(trx, { courseIds: [course] })).toEqual([course]);
      await recomputeCourseRating(trx, course);
      expect(await findRatingStatsDrift(trx, { courseIds: [course] })).toEqual([]);
      expect((await getCourseRatings(trx, [course]))[0]).toMatchObject({ reviewCount: 6 });
    });
  });

  it('parallel recomputes of one course serialise on the stats row and converge', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const course = randomUUID();
    committedCourses.push(course);
    const reviewers = await users(6);
    await Promise.all(
      reviewers.map((u, i) =>
        Promise.all([
          upsertReview(pg.db, { courseId: course, userId: u, rating: (i % 5) + 1, body: null }),
          pg.db.transaction().execute((trx) => recomputeCourseRating(trx, course)),
        ]),
      ),
    );
    await Promise.all(
      Array.from({ length: 5 }, () =>
        pg.db.transaction().execute((trx) => recomputeCourseRating(trx, course)),
      ),
    );
    expect(await findRatingStatsDrift(pg.db, { courseIds: [course] })).toEqual([]);
    expect((await getCourseRatings(pg.db, [course]))[0]).toMatchObject({ reviewCount: 6 });
  });
});

describe('moderation (D13, R9)', () => {
  it('3 concurrent reporters auto-hide the subject exactly once', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const [author, ...reporters] = await users(4);
    const q = await createQuestion(pg.db, { authorId: author!, courseId: randomUUID() });
    const results = await Promise.all(
      reporters.map((reporterId) =>
        settle(
          pg.db.transaction().execute((trx) =>
            reportContent(trx, {
              subjectType: 'QUESTION',
              subjectId: q,
              reporterId,
              reason: 'SPAM',
              comment: null,
              autoHideThreshold: 3,
            }),
          ),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(
      results.filter((r) => r.ok && r.value.outcome === 'REPORTED' && r.value.autoHidden),
    ).toHaveLength(1);
    const { rows } = await sql<{ status: string; hides: number; open: number }>`
      SELECT q.moderation_status AS status,
             (SELECT count(*)::int FROM engagement.moderation_actions m
               WHERE m.subject_type = 'QUESTION' AND m.subject_id = q.id AND m.action = 'HIDE' AND m.actor_id IS NULL) AS hides,
             (SELECT count(*)::int FROM engagement.question_reports r WHERE r.subject_id = q.id AND r.status = 'OPEN') AS open
        FROM engagement.questions q WHERE q.id = ${q}`.execute(pg.db);
    expect(rows[0]).toEqual({ status: 'HIDDEN', hides: 1, open: 0 });
  });

  it('a status change without an action, or an action without a status change, fails at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const silent = await deferredFailure(pg.db, async (trx) => {
      const u = await createUser(trx);
      const r = await createReviewRow(trx, { courseId: randomUUID(), userId: u, rating: 4 });
      await sql`UPDATE engagement.reviews SET moderation_status = 'HIDDEN' WHERE id = ${r}`.execute(
        trx,
      );
    });
    expect(silent).toMatchObject({ code: '23514', constraint: 'moderation_status_log_ck' });
    const orphan = await deferredFailure(pg.db, async (trx) => {
      const admin = await createUser(trx);
      await sql`
        INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
        VALUES ('ANSWER', ${randomUUID()}, 'HIDE', ${admin}, 'Hiding something unknown')`.execute(
        trx,
      );
    });
    expect(orphan).toMatchObject({ code: '23514', constraint: 'moderation_actions_subject_ck' });
    await rollback(pg.db, async (trx) => {
      const auto = await expectFailure(trx, () =>
        sql`
          INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
          VALUES ('REVIEW', ${randomUUID()}, 'RESTORE', NULL, NULL)`.execute(trx),
      );
      expect(auto).toMatchObject({ code: '23514', constraint: 'moderation_actions_reason_ck' });
    });
  });
});

describe('append-only, insert/delete-only and frozen engagement rows', () => {
  it('logs are append-only (42501); votes/wishlist are insert/delete only; deleted content and announcements are frozen', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const author = await createUser(trx);
      const other = await createUser(trx);
      const admin = await createUser(trx);
      const course = randomUUID();
      const q = await createQuestion(trx, { authorId: author, courseId: course });
      await castVote(trx, { subject: 'QUESTION', subjectId: q, userId: other });
      await moderateSubject(trx, {
        subjectType: 'QUESTION',
        subjectId: q,
        action: 'HIDE',
        actorId: admin,
        reason: 'Duplicate of another one',
      });
      await sql`INSERT INTO engagement.wishlist_items (user_id, course_id) VALUES (${other}, ${course})`.execute(
        trx,
      );
      const ann = await sql<{ id: string }>`
        INSERT INTO engagement.announcements (course_id, author_id, title, body_md, send_email)
        VALUES (${course}, ${author}, 'Welcome all', 'Hello', false) RETURNING id`.execute(trx);
      const review = await createReviewRow(trx, { courseId: course, userId: other, rating: 2 });
      await sql`UPDATE engagement.reviews SET deleted_at = now(), deleted_by = ${other} WHERE id = ${review}`.execute(
        trx,
      );

      for (const [label, statement, code, constraint] of [
        [
          'update moderation_actions',
          sql`UPDATE engagement.moderation_actions SET reason = 'Something else entirely' WHERE subject_id = ${q}`,
          '42501',
          undefined,
        ],
        [
          'delete moderation_actions',
          sql`DELETE FROM engagement.moderation_actions WHERE subject_id = ${q}`,
          '42501',
          undefined,
        ],
        [
          'update vote',
          sql`UPDATE engagement.question_votes SET created_at = now() WHERE subject_id = ${q}`,
          '23514',
          'question_votes_immutable_ck',
        ],
        [
          'update wishlist',
          sql`UPDATE engagement.wishlist_items SET added_at = now() WHERE user_id = ${other}`,
          '23514',
          'wishlist_items_immutable_ck',
        ],
        [
          'edit announcement',
          sql`UPDATE engagement.announcements SET title = 'Edited title' WHERE id = ${ann.rows[0]!.id}`,
          '23514',
          'announcements_immutable_ck',
        ],
        [
          'edit deleted review',
          sql`UPDATE engagement.reviews SET rating = 5 WHERE id = ${review}`,
          '23514',
          'reviews_immutable_ck',
        ],
      ] as const) {
        const err = await expectFailure(trx, () => statement.execute(trx));
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code,
          constraint,
        });
      }
      await sql`UPDATE engagement.announcements SET deleted_at = now(), deleted_by = ${author} WHERE id = ${ann.rows[0]!.id}`.execute(
        trx,
      );
      const twice = await expectFailure(trx, () =>
        sql`UPDATE engagement.announcements SET deleted_at = now(), deleted_by = ${admin} WHERE id = ${ann.rows[0]!.id}`.execute(
          trx,
        ),
      );
      expect(twice).toMatchObject({ code: '23514', constraint: 'announcements_immutable_ck' });
    });
    for (const statement of [
      'TRUNCATE engagement.moderation_actions',
      'TRUNCATE engagement.question_reports',
      'TRUNCATE engagement.reviews CASCADE',
      'TRUNCATE engagement.questions CASCADE',
      'TRUNCATE engagement.announcements',
    ]) {
      await rollback(pg.db, async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        const err = await expectFailure(trx, () => sql.raw(statement).execute(trx));
        expect({ statement, code: err.code }).toEqual({ statement, code: '42501' });
      });
    }
  });
});
