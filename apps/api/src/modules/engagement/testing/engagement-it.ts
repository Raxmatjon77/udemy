import { type DB, type Kysely, sql } from '@udemy/db';
import type { LectureCompletionCounter } from '../../../shared/learning-progress';

/**
 * Integration/e2e support for engagement (IT conventions of `src/testing/integration.ts`): every
 * file owns its data and removes it in afterAll.
 */

/**
 * A controllable `LECTURE_COMPLETIONS` binding for e2e files (`useE2eApp({ overrides })`):
 * learning (P5-T10) is not there yet, and the review gate needs >= 1 completed lecture.
 */
export class TestLectureCompletions implements LectureCompletionCounter {
  private readonly counts = new Map<string, number>();

  set(userId: string, courseId: string, count: number): void {
    this.counts.set(`${userId}:${courseId}`, count);
  }

  completedLectureCount(userId: string, courseId: string): Promise<number> {
    return Promise.resolve(this.counts.get(`${userId}:${courseId}`) ?? 0);
  }
}

/**
 * Deletes the engagement rows of the given users and courses (reviews of the courses or by the
 * users, their replies, questions, answers, votes, announcements, reports, moderation log,
 * rating rows, wishlist items) and the engagement outbox events of the courses. Runs as the table owner with triggers disabled
 * (`session_replication_role = replica`): reviews and reports are never deleted in production.
 */
export async function deleteEngagementTestData(
  db: Kysely<DB>,
  options: { userIds: readonly string[]; courseIds: readonly string[] },
): Promise<void> {
  const users = [...new Set(options.userIds)];
  const courses = [...new Set(options.courseIds)];
  if (users.length === 0 && courses.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    const userList =
      users.length === 0 ? sql`NULL::uuid` : sql.join(users.map((u) => sql`${u}::uuid`));
    const courseList =
      courses.length === 0 ? sql`NULL::uuid` : sql.join(courses.map((c) => sql`${c}::uuid`));
    const reviewIds = sql`(SELECT id FROM engagement.reviews WHERE course_id IN (${courseList}) OR user_id IN (${userList}))`;
    const replyIds = sql`(SELECT id FROM engagement.review_replies WHERE review_id IN ${reviewIds} OR author_id IN (${userList}))`;
    await sql`DELETE FROM engagement.review_reply_reports WHERE subject_id IN ${replyIds} OR reporter_id IN (${userList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.review_reports WHERE subject_id IN ${reviewIds} OR reporter_id IN (${userList})`.execute(
      trx,
    );
    // Q&A (P5-T13): questions of the courses or by the users, and every answer to them or by them
    const questionIds = sql`(SELECT id FROM engagement.questions WHERE course_id IN (${courseList}) OR author_id IN (${userList}))`;
    const answerIds = sql`(SELECT id FROM engagement.answers WHERE question_id IN ${questionIds} OR author_id IN (${userList}))`;
    await sql`DELETE FROM engagement.question_votes WHERE subject_id IN ${questionIds} OR user_id IN (${userList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.answer_votes WHERE subject_id IN ${answerIds} OR user_id IN (${userList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.question_reports WHERE subject_id IN ${questionIds} OR reporter_id IN (${userList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.answer_reports WHERE subject_id IN ${answerIds} OR reporter_id IN (${userList})`.execute(
      trx,
    );
    await sql`
      DELETE FROM engagement.moderation_actions
       WHERE (subject_type = 'REVIEW' AND subject_id IN ${reviewIds})
          OR (subject_type = 'REVIEW_REPLY' AND subject_id IN ${replyIds})
          OR (subject_type = 'QUESTION' AND subject_id IN ${questionIds})
          OR (subject_type = 'ANSWER' AND subject_id IN ${answerIds})
          OR actor_id IN (${userList})
    `.execute(trx);
    await sql`UPDATE engagement.questions SET accepted_answer_id = NULL WHERE id IN ${questionIds}`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.answers WHERE id IN ${answerIds}`.execute(trx);
    await sql`DELETE FROM engagement.questions WHERE id IN ${questionIds}`.execute(trx);
    await sql`DELETE FROM engagement.announcements WHERE course_id IN (${courseList}) OR author_id IN (${userList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.review_replies WHERE id IN ${replyIds}`.execute(trx);
    await sql`DELETE FROM engagement.reviews WHERE id IN ${reviewIds}`.execute(trx);
    await sql`DELETE FROM engagement.course_rating_stats WHERE course_id IN (${courseList})`.execute(
      trx,
    );
    await sql`DELETE FROM engagement.wishlist_items WHERE user_id IN (${userList}) OR course_id IN (${courseList})`.execute(
      trx,
    );
    if (courses.length > 0) {
      await trx
        .deleteFrom('outbox.events')
        .where('aggregateType', 'like', 'engagement.%')
        .where('aggregateId', 'in', courses)
        .execute();
    }
  });
}
