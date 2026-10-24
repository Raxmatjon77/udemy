import { randomUUID } from 'node:crypto';
import { reportContent, sql } from '@udemy/db';
import type { Database } from '@udemy/nest-common';
import { afterAll, describe, expect, it } from 'vitest';
import { useIntegrationDatabase } from '../../../testing/integration';
import { insertCatalogTestUser } from '../../catalog/testing/catalog-it';
import { deleteUsersTestData } from '../../users/testing/users-test-data';
import { AnswerNotFound, CannotVoteOwnContent } from '../domain/engagement.errors';
import { deleteEngagementTestData } from '../testing/engagement-it';
import { KyselyAnnouncementRepository } from './kysely-announcement.repository';
import { KyselyModerationRepository } from './kysely-moderation.repository';
import { KyselyQaRepository } from './kysely-qa.repository';
import { KyselyReviewRepository } from './kysely-review.repository';
import { KyselyTransactionRunner } from './kysely-transaction-runner';

/*
 * P5-T13 engagement adapters against the integration Postgres (migration 0005): Q&A writes and
 * the trigger-maintained counters (never written by the app), keyset paging per sort with exact
 * timestamps, the accepted-answer FK/guard and its clearing, votes under concurrency (R7/R8),
 * the announcement quota under the `anno` lock (R12), and the moderation queue over the
 * `content_reports` view with the review-reply id mapping. Course ids are soft references.
 */
describe('engagement B repositories (integration: Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const userIds: string[] = [];
  const courseIds: string[] = [];

  const db = (): Database => pg.db;
  const qa = () => new KyselyQaRepository(db());
  const announcements = () => new KyselyAnnouncementRepository(db());
  const moderation = () => new KyselyModerationRepository(db());
  const tx = () => new KyselyTransactionRunner(db());

  async function user(label: string): Promise<string> {
    const id = await insertCatalogTestUser(pg.db, `engb-${label}`);
    userIds.push(id);
    return id;
  }

  function course(): string {
    const id = randomUUID();
    courseIds.push(id);
    return id;
  }

  afterAll(async () => {
    if (!pg.available) return;
    await deleteEngagementTestData(pg.db, { userIds, courseIds });
    await deleteUsersTestData(pg.db, userIds);
  });

  async function question(courseId: string, authorId: string, title: string, lectureId?: string) {
    return tx().run((trx) =>
      qa().insertQuestion(trx, {
        courseId,
        lectureId: lectureId ?? null,
        authorId,
        title,
        bodyMd: 'Body *md*',
      }),
    );
  }

  async function answer(questionId: string, authorId: string) {
    return tx().run((trx) => qa().insertAnswer(trx, { questionId, authorId, bodyMd: 'An answer' }));
  }

  it('answers maintain answer_count / last_activity_at; the accepted answer is cleared on delete', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const asker = await user('asker');
    const helper = await user('helper');
    const q = await question(c, asker, 'Counters question');
    expect(q).toMatchObject({ answerCount: 0, upvoteCount: 0, acceptedAnswerId: null });

    const a1 = await answer(q.id, helper);
    const a2 = await answer(q.id, asker);
    const after = await qa().findQuestion(q.id);
    expect(after?.answerCount).toBe(2);
    expect(after?.lastActivityAt.getTime()).toBe(a2.createdAt.getTime());

    // a foreign answer cannot be accepted (composite FK / visible guard -> answer_not_found)
    const other = await question(c, asker, 'Another question');
    const foreign = await answer(other.id, helper);
    await expect(
      tx().run((trx) => qa().setAcceptedAnswer(trx, q.id, foreign.id)),
    ).rejects.toBeInstanceOf(AnswerNotFound);

    const accepted = await tx().run((trx) => qa().setAcceptedAnswer(trx, q.id, a1.id));
    expect(accepted).toMatchObject({
      previousAnswerId: null,
      question: { acceptedAnswerId: a1.id },
    });

    const wasAccepted = await tx().run(async (trx) => {
      const lock = await qa().lockAnswerAcceptance(trx, a1.id);
      await qa().softDeleteAnswer(trx, a1.id);
      return lock?.wasAccepted;
    });
    expect(wasAccepted).toBe(true);
    expect(await qa().findQuestion(q.id)).toMatchObject({ acceptedAnswerId: null, answerCount: 1 });
    expect(await tx().run((trx) => qa().softDeleteAnswer(trx, a1.id))).toBeNull();

    // edited_at moves only on a real change; deleted content is frozen
    const same = await tx().run((trx) =>
      qa().updateQuestion(trx, q.id, { title: 'Counters question' }),
    );
    expect(same?.editedAt).toBeNull();
    const changed = await tx().run((trx) => qa().updateQuestion(trx, q.id, { bodyMd: 'New body' }));
    expect(changed?.editedAt).not.toBeNull();
    await tx().run((trx) => qa().softDeleteQuestion(trx, q.id));
    expect(await tx().run((trx) => qa().updateQuestion(trx, q.id, { bodyMd: 'x' }))).toBeNull();
  });

  it('votes: 20 parallel by one user count once; own content refused; retract', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const asker = await user('vote-asker');
    const voter = await user('voter');
    const q = await question(c, asker, 'Vote on me please');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => qa().castVote('QUESTION', q.id, voter)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await qa().findQuestion(q.id))?.upvoteCount).toBe(1);
    expect(await qa().votedAmong('QUESTION', [q.id, randomUUID()], voter)).toEqual(new Set([q.id]));
    await expect(qa().castVote('QUESTION', q.id, asker)).rejects.toBeInstanceOf(
      CannotVoteOwnContent,
    );
    expect(await qa().retractVote('QUESTION', q.id, voter)).toBe(true);
    expect(await qa().retractVote('QUESTION', q.id, voter)).toBe(false);
    expect((await qa().findQuestion(q.id))?.upvoteCount).toBe(0);
  });

  it('listQuestions keysets (recent/top/unanswered, lecture, title search) and the inbox', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const lecture = randomUUID();
    const asker = await user('list-asker');
    const helper = await user('list-helper');
    const q1 = await question(c, asker, 'Alpha about closures', lecture);
    const q2 = await question(c, asker, 'Beta question');
    const q3 = await question(c, asker, 'Gamma about closures');
    await answer(q1.id, helper);
    await qa().castVote('QUESTION', q3.id, helper);

    const page = (sort: 'recent' | 'top' | 'unanswered', extra: object = {}) =>
      qa().listQuestions({ courseId: c, sort, after: null, limit: 10, ...extra });
    expect((await page('recent')).map((r) => r.question.id)).toEqual([q1.id, q3.id, q2.id]);
    expect((await page('top')).map((r) => r.question.id)[0]).toBe(q3.id);
    expect((await page('unanswered')).map((r) => r.question.id)).toEqual([q3.id, q2.id]);
    expect((await page('recent', { lectureId: lecture })).map((r) => r.question.id)).toEqual([
      q1.id,
    ]);
    expect(
      (await page('recent', { titleContains: 'closures' })).map((r) => r.question.id).sort(),
    ).toEqual([q1.id, q3.id].sort());
    // '%' is a literal in the search
    expect(await page('recent', { titleContains: '%%%' })).toEqual([]);

    const first = await qa().listQuestions({ courseId: c, sort: 'recent', after: null, limit: 1 });
    const rest = await qa().listQuestions({
      courseId: c,
      sort: 'recent',
      after: first[0]?.cursor ?? null,
      limit: 10,
    });
    expect(rest.map((r) => r.question.id)).toEqual([q3.id, q2.id]);

    const inbox = await qa().listInbox({
      courseIds: [c],
      status: 'unanswered',
      after: null,
      limit: 10,
    });
    expect(inbox.map((r) => r.record.id)).toEqual([q3.id, q2.id]);
    expect(inbox[0]?.createdAtKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('announcement quota: 6 parallel posts under the anno lock -> exactly 4; deleted posts still count', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const owner = await user('anno-owner');
    const repo = announcements();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        tx().run(async (trx) => {
          if ((await repo.lockQuota(trx, c)) >= 4) throw new Error('quota');
          return repo.insert(trx, {
            courseId: c,
            authorId: owner,
            title: `Announcement ${i}`,
            bodyMd: 'Hello',
            sendEmail: false,
          });
        }),
      ),
    );
    const posted = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
    expect(posted).toHaveLength(4);
    const first = posted[0];
    if (first === undefined) throw new Error('nothing posted');
    const deleted = await tx().run((trx) => repo.softDelete(trx, c, first.id, owner));
    expect(deleted?.announcement.id).toBe(first.id);
    expect(await tx().run((trx) => repo.softDelete(trx, c, first.id, owner))).toBeNull();
    expect(await tx().run((trx) => repo.lockQuota(trx, c))).toBe(4);
    expect(await repo.windowCreatedAts(c)).toHaveLength(4);
    expect((await repo.listLive(c, null, 10)).map((r) => r.record.id)).not.toContain(first.id);
  });

  it('moderation: queue groups by subject, reply rows map to the review id; hide/confirm/restore/dismiss', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const author = await user('mod-author');
    const owner = await user('mod-owner');
    const reporter = await user('mod-reporter');
    const admin = await user('mod-admin');
    const reviewsRepo = new KyselyReviewRepository(db());
    const review = await tx().run((trx) =>
      reviewsRepo.upsert(trx, { courseId: c, userId: author, rating: 3, body: null }),
    );
    const withReply = await tx().run((trx) =>
      reviewsRepo.upsertReply(trx, { reviewId: review.review.id, authorId: owner, body: 'Hi' }),
    );
    const replyId = withReply.review.reply?.id ?? '';
    const q = await question(c, author, 'Reported question');
    for (const [type, id] of [
      ['REVIEW_REPLY', replyId],
      ['QUESTION', q.id],
    ] as const) {
      await tx().run((trx) =>
        reportContent(trx, {
          subjectType: type,
          subjectId: id,
          reporterId: reporter,
          reason: 'SPAM',
          comment: null,
          autoHideThreshold: 3,
        }),
      );
    }
    const repo = moderation();
    const queue = await repo.queuePage({ status: 'OPEN', after: null, limit: 50 });
    const mine = queue.filter((r) => r.ref.id === replyId || r.ref.id === q.id);
    expect(mine.map((r) => r.ref)).toEqual([
      { type: 'QUESTION', id: q.id },
      { type: 'REVIEW_REPLY', id: replyId },
    ]);
    const resolved = await repo.resolveRoute('REVIEW_REPLY', review.review.id);
    expect(resolved).toMatchObject({ id: replyId, routeId: review.review.id, courseId: c });
    const reports = await repo.reportsOf([{ type: 'REVIEW_REPLY', id: replyId }], 20);
    expect(reports.map((r) => r.reporterId)).toEqual([reporter]);

    const act = (
      action: 'HIDE' | 'RESTORE' | 'DISMISS_REPORTS',
      ref = { type: 'QUESTION' as const, id: q.id },
    ) =>
      tx().run((trx) =>
        repo.moderate(trx, { ref, action, actorId: admin, reason: 'Moderation reason' }),
      );
    expect(await act('HIDE')).toMatchObject({
      outcome: 'APPLIED',
      statusChanged: true,
      resolvedReports: 1,
    });
    expect(await act('HIDE')).toEqual({ outcome: 'NOOP' });
    expect(await act('DISMISS_REPORTS')).toEqual({ outcome: 'NOOP' });
    expect(await act('RESTORE')).toMatchObject({ outcome: 'APPLIED', moderationStatus: 'VISIBLE' });
    expect((await repo.actionsOf([{ type: 'QUESTION', id: q.id }])).map((a) => a.action)).toEqual([
      'HIDE',
      'RESTORE',
    ]);
    expect(await repo.openReportCounts([{ type: 'QUESTION', id: q.id }])).toEqual(new Map());

    // reported, then deleted: hide is DELETED, dismiss still clears the queue
    const doomed = await question(c, author, 'Doomed question');
    await tx().run((trx) =>
      reportContent(trx, {
        subjectType: 'QUESTION',
        subjectId: doomed.id,
        reporterId: reporter,
        reason: 'OTHER',
        comment: null,
        autoHideThreshold: 3,
      }),
    );
    await tx().run((trx) => qa().softDeleteQuestion(trx, doomed.id));
    const doomedRef = { type: 'QUESTION' as const, id: doomed.id };
    expect(await act('HIDE', doomedRef)).toEqual({ outcome: 'DELETED' });
    expect(await act('DISMISS_REPORTS', doomedRef)).toMatchObject({
      outcome: 'APPLIED',
      resolvedReports: 1,
    });
    expect(await act('HIDE', { type: 'QUESTION', id: randomUUID() })).toEqual({
      outcome: 'NOT_FOUND',
    });

    // the status log stays consistent (checked at COMMIT): no violation surfaced above
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM engagement.moderation_actions WHERE subject_id = ${doomed.id}
    `.execute(pg.db);
    expect(rows[0]?.n).toBe(1);
  });
});
