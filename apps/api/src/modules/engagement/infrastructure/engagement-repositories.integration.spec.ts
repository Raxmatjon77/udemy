import { randomUUID } from 'node:crypto';
import { recomputeCourseRating, sql } from '@udemy/db';
import type { Database } from '@udemy/nest-common';
import { afterAll, describe, expect, it } from 'vitest';
import { useIntegrationDatabase } from '../../../testing/integration';
import { insertCatalogTestUser } from '../../catalog/testing/catalog-it';
import { deleteUsersTestData } from '../../users/testing/users-test-data';
import { CannotReportOwnContent } from '../domain/engagement.errors';
import { deleteEngagementTestData } from '../testing/engagement-it';
import { KyselyReportRepository } from './kysely-report.repository';
import { KyselyReviewRepository } from './kysely-review.repository';
import { KyselyTransactionRunner } from './kysely-transaction-runner';
import { KyselyWishlistRepository } from './kysely-wishlist.repository';

/*
 * The engagement Kysely adapters against the integration Postgres (migration 0005): the review
 * and reply upserts with their re-reads, the exact-timestamp keysets, soft deletes, the
 * share-lock of a review, the report auto-hide under concurrency (R9), and the wishlist cap
 * lock and keyset. Course ids are soft references (no catalog rows needed).
 */
describe('engagement repositories (integration: Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 6 });
  const userIds: string[] = [];
  const courseIds: string[] = [];

  const db = (): Database => pg.db;
  const reviews = () => new KyselyReviewRepository(db());
  const reports = () => new KyselyReportRepository(db());
  const wishlist = () => new KyselyWishlistRepository(db());
  const tx = () => new KyselyTransactionRunner(db());

  async function user(label: string): Promise<string> {
    const id = await insertCatalogTestUser(pg.db, `eng-${label}`);
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

  it('review upsert: POSTED -> UNCHANGED -> EDITED with previousRating; parallel upserts make one row (R4)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const u = await user('reviewer');
    const repo = reviews();
    const runner = tx();

    const posted = await runner.run((trx) =>
      repo.upsert(trx, { courseId: c, userId: u, rating: 4, body: 'Good' }),
    );
    const same = await runner.run((trx) =>
      repo.upsert(trx, { courseId: c, userId: u, rating: 4, body: 'Good' }),
    );
    const edited = await runner.run((trx) =>
      repo.upsert(trx, { courseId: c, userId: u, rating: 2, body: 'Good' }),
    );
    expect([posted.outcome, same.outcome, edited.outcome]).toEqual([
      'POSTED',
      'UNCHANGED',
      'EDITED',
    ]);
    expect(edited.previousRating).toBe(4);
    expect(edited.review).toMatchObject({
      id: posted.review.id,
      rating: 2,
      moderationStatus: 'VISIBLE',
    });
    expect(edited.review.editedAt).not.toBeNull();

    const racer = await user('racer');
    const c2 = course();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((rating) =>
        runner.run((trx) => repo.upsert(trx, { courseId: c2, userId: racer, rating, body: null })),
      ),
    );
    expect(new Set(results.map((r) => r.review.id)).size).toBe(1);
    expect(results.filter((r) => r.outcome === 'POSTED')).toHaveLength(1);
  });

  it('lists: exact-timestamp keyset visits every published review once; live list includes hidden', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const repo = reviews();
    const runner = tx();
    const authors = await Promise.all([1, 2, 3, 4].map((n) => user(`list-${n}`)));
    // all in ONE transaction: identical created_at, so the id breaks every tie
    const ids = await runner.run(async (trx) => {
      const out: string[] = [];
      for (const userId of authors) {
        out.push(
          (await repo.upsert(trx, { courseId: c, userId, rating: 5, body: null })).review.id,
        );
      }
      return out;
    });
    const hiddenId = ids[0] ?? '';
    await pg.db.transaction().execute(async (trx) => {
      await sql`UPDATE engagement.reviews SET moderation_status = 'HIDDEN' WHERE id = ${hiddenId}`.execute(
        trx,
      );
      await sql`
        INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
        VALUES ('REVIEW', ${hiddenId}, 'HIDE', NULL, NULL)
      `.execute(trx);
    });

    const seen: string[] = [];
    let after: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page = await repo.listPublished({ courseId: c, after, limit: 1 });
      const row = page[0];
      if (row === undefined) break;
      expect(row.createdAtKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      seen.push(row.review.id);
      after = { createdAt: row.createdAtKey, id: row.review.id };
    }
    expect(seen.sort()).toEqual(ids.filter((id) => id !== hiddenId).sort());
    const live = await repo.listLive({ courseId: c, after: null, limit: 10 });
    expect(live.map((r) => r.review.id).sort()).toEqual([...ids].sort());
  });

  it('replies: upsert re-reads the live reply; soft delete; a deleted review is no longer lockable', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const owner = await user('owner');
    const student = await user('student');
    const repo = reviews();
    const runner = tx();
    const { review } = await runner.run((trx) =>
      repo.upsert(trx, { courseId: c, userId: student, rating: 3, body: null }),
    );

    const posted = await runner.run(async (trx) => {
      const locked = await repo.lockLiveInCourse(trx, c, review.id);
      expect(locked?.id).toBe(review.id);
      expect(await repo.lockLiveInCourse(trx, randomUUID(), review.id)).toBeNull();
      return repo.upsertReply(trx, { reviewId: review.id, authorId: owner, body: 'Thanks' });
    });
    expect(posted.outcome).toBe('POSTED');
    expect(posted.review.reply).toMatchObject({
      authorId: owner,
      body: 'Thanks',
      moderationStatus: 'VISIBLE',
    });

    const deletedReply = await runner.run((trx) => repo.softDeleteReply(trx, review.id));
    expect(deletedReply).toMatchObject({ authorId: owner });
    expect(await runner.run((trx) => repo.softDeleteReply(trx, review.id))).toBeNull();
    expect((await repo.findLiveById(review.id))?.reply).toBeNull();

    const deleted = await runner.run((trx) => repo.softDeleteByUser(trx, c, student));
    expect(deleted?.id).toBe(review.id);
    expect(await runner.run((trx) => repo.lockLiveInCourse(trx, c, review.id))).toBeNull();
    expect(await repo.findLiveByUser(c, student)).toBeNull();
  });

  it('reports: 3 concurrent reporters auto-hide exactly once (R9); own content maps to 422', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const author = await user('author');
    const reporters = await Promise.all([1, 2, 3].map((n) => user(`reporter-${n}`)));
    const repo = reviews();
    const runner = tx();
    const { review } = await runner.run((trx) =>
      repo.upsert(trx, { courseId: c, userId: author, rating: 1, body: null }),
    );

    const outcomes = await Promise.all(
      reporters.map((reporterId) =>
        runner.run((trx) =>
          reports().file(trx, {
            subjectType: 'REVIEW',
            subjectId: review.id,
            reporterId,
            reason: 'SPAM',
            comment: null,
            autoHideThreshold: 3,
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.outcome === 'REPORTED' && o.autoHidden)).toHaveLength(1);
    expect((await repo.findLiveById(review.id))?.moderationStatus).toBe('HIDDEN');
    const mine = await reports().findByReporter('REVIEW', review.id, reporters[0] ?? '');
    expect(mine).toMatchObject({ reason: 'SPAM', status: 'ACTIONED' });
    expect(mine?.resolvedAt).not.toBeNull();

    await expect(
      runner.run((trx) =>
        reports().file(trx, {
          subjectType: 'REVIEW',
          subjectId: review.id,
          reporterId: author,
          reason: 'OTHER',
          comment: null,
          autoHideThreshold: 3,
        }),
      ),
    ).rejects.toBeInstanceOf(CannotReportOwnContent);
  });

  it('wishlist: insert-once under parallel adds, cap count under the wish lock, keyset list', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const u = await user('wisher');
    const repo = wishlist();
    const runner = tx();
    const [a, b, c] = [course(), course(), course()];

    const added = await Promise.all([1, 2, 3].map(() => runner.run((trx) => repo.add(trx, u, a))));
    expect(added.filter(Boolean)).toHaveLength(1);
    await runner.run((trx) => repo.add(trx, u, b));
    await runner.run((trx) => repo.add(trx, u, c));
    expect(await runner.run((trx) => repo.lockCap(trx, u))).toBe(3);

    const seen: string[] = [];
    let after: { addedAt: string; courseId: string } | null = null;
    for (;;) {
      const rows = await repo.listPage(u, after, 2);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.courseId));
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      after = { addedAt: last.addedAtKey, courseId: last.courseId };
    }
    expect(seen.sort()).toEqual([a, b, c].sort());
    expect([...(await repo.wishlistedAmong(u, [a, randomUUID()]))]).toEqual([a]);
    expect(await repo.remove(u, a)).toBe(true);
    expect(await repo.remove(u, a)).toBe(false);
  });

  it('ratings: the read model through @udemy/db (count_1..count_5 aliased)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const c = course();
    const repo = reviews();
    const runner = tx();
    for (const [n, rating] of [
      [1, 4],
      [2, 5],
    ] as const) {
      const u = await user(`rater-${n}`);
      await runner.run((trx) => repo.upsert(trx, { courseId: c, userId: u, rating, body: null }));
    }
    await pg.db.transaction().execute((trx) => recomputeCourseRating(trx, c));
    expect(await repo.getRatings([c, randomUUID()])).toEqual([
      { courseId: c, reviewCount: 2, average: '4.5', counts: [0, 0, 0, 1, 1] },
    ]);
  });
});
