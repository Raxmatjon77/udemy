import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import {
  findRatingStatsDrift,
  getCourseRatings,
  grantEnrollment,
  revokeEnrollment,
} from '@udemy/db';
import {
  createActiveEnrollment,
  createReviewRow,
  createUser,
  deleteTestData,
  skipUnlessMigrated,
  useIntegrationDb,
} from '@udemy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { cleanupPhase5, phase5Envelope, registered } from '../testing/phase5-fixtures';
import { RatingOnReviewPosted } from './handlers/rating-aggregator.handlers';
import {
  ReviewReinstateOnRegrantHandler,
  ReviewSuspendOnRevokeHandler,
} from './handlers/review-enrollment-sync.handlers';
import { ReviewSuspension } from './persistence/review-suspension';

/**
 * engagement.rating-aggregator and engagement.review-enrollment-sync against the dev Postgres
 * with the real idempotent processor. Course ids are soft (random uuids). Every check is scoped
 * to this file's courses (the database is shared).
 *
 * WRITTEN IN CODE-ONLY MODE (P5-T15): never run yet.
 */
describe('rating aggregator + review-enrollment sync (integration: Postgres)', () => {
  const pg = useIntegrationDb();
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const courseIds: string[] = [];
  let processor: IdempotentEventProcessor;
  let aggregator: RegisteredEventHandler;
  let suspend: RegisteredEventHandler;
  let reinstate: RegisteredEventHandler;

  beforeAll(() => {
    if (pg.unavailableReason !== undefined) return;
    const reviews = new ReviewSuspension();
    aggregator = registered(
      'engagement.course_review',
      'ReviewPosted',
      'engagement.rating-aggregator.review-posted',
      new RatingOnReviewPosted(),
    );
    suspend = registered(
      'enrollment.enrollment',
      'EnrollmentRevoked',
      'engagement.review-enrollment-sync.enrollment-revoked',
      new ReviewSuspendOnRevokeHandler(reviews),
    );
    reinstate = registered(
      'enrollment.enrollment',
      'EnrollmentGranted',
      'engagement.review-enrollment-sync.enrollment-granted',
      new ReviewReinstateOnRegrantHandler(reviews),
    );
    processor = new IdempotentEventProcessor(pg.db);
  });

  afterAll(async () => {
    if (pg.unavailableReason !== undefined) return;
    await cleanupPhase5(pg.db, { eventIds, courseIds });
    await deleteTestData(pg.db, userIds);
  });

  function track(envelope: EventEnvelope): EventEnvelope {
    eventIds.push(envelope.eventId);
    return envelope;
  }

  async function users(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await createUser(pg.db));
    userIds.push(...ids);
    return ids;
  }

  function course(): string {
    const id = randomUUID();
    courseIds.push(id);
    return id;
  }

  const reviewPosted = (courseId: string, reviewId: string, userId: string, rating: number) =>
    track(
      phase5Envelope('ReviewPosted', 'engagement.course_review', courseId, {
        reviewId,
        courseId,
        userId,
        rating,
        previousRating: null,
        postedAt: new Date().toISOString(),
      }),
    );

  it('recomputes the whole histogram; a redelivery is a duplicate and nothing drifts', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const courseId = course();
    const [a, b, c] = await users(3);
    const ra = await createReviewRow(pg.db, { courseId, userId: a!, rating: 5 });
    await createReviewRow(pg.db, { courseId, userId: b!, rating: 4 });
    await createReviewRow(pg.db, { courseId, userId: c!, rating: 1 });
    const event = reviewPosted(courseId, ra, a!, 5);

    await expect(processor.process(aggregator, event)).resolves.toBe('processed');
    await expect(processor.process(aggregator, event)).resolves.toBe('duplicate');

    const [rating] = await getCourseRatings(pg.db, [courseId]);
    expect(rating).toMatchObject({ reviewCount: 3, average: '3.3', counts: [1, 0, 0, 1, 1] });
    expect(await findRatingStatsDrift(pg.db, { courseIds: [courseId] })).toEqual([]);
  }, 30_000);

  it('a revoked enrollment suspends the review (out of the aggregate); a regrant reinstates it', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const courseId = course();
    const [learner, other, admin] = await users(3);
    await pg.db.transaction().execute(async (trx) => {
      await createActiveEnrollment(trx, { userId: learner!, courseId });
    });
    const reviewId = await createReviewRow(pg.db, { courseId, userId: learner!, rating: 1 });
    const otherReview = await createReviewRow(pg.db, { courseId, userId: other!, rating: 5 });
    await processor.process(aggregator, reviewPosted(courseId, otherReview, other!, 5));
    expect((await getCourseRatings(pg.db, [courseId]))[0]?.reviewCount).toBe(2);

    await pg.db.transaction().execute((trx) =>
      revokeEnrollment(trx, {
        userId: learner!,
        courseId,
        revokeReason: 'ADMIN',
        actorId: admin!,
        reason: 'integration test revoke',
      }),
    );
    const revoked = track(
      phase5Envelope('EnrollmentRevoked', 'enrollment.enrollment', learner!, {
        enrollmentId: learner!,
        userId: learner!,
        courseId,
        reason: 'ADMIN',
        refundId: null,
        actorId: admin!,
        revokedAt: new Date().toISOString(),
      }),
    );
    await expect(processor.process(suspend, revoked)).resolves.toBe('processed');
    await expect(processor.process(suspend, revoked)).resolves.toBe('duplicate');

    const suspended = await pg.db
      .selectFrom('engagement.reviews')
      .select('suspendedAt')
      .where('id', '=', reviewId)
      .executeTakeFirstOrThrow();
    expect(suspended.suspendedAt).not.toBeNull();
    expect((await getCourseRatings(pg.db, [courseId]))[0]).toMatchObject({
      reviewCount: 1,
      counts: [0, 0, 0, 0, 1],
    });

    await pg.db
      .transaction()
      .execute((trx) => grantEnrollment(trx, { userId: learner!, courseId, source: 'FREE' }));
    const regrant = track(
      phase5Envelope('EnrollmentGranted', 'enrollment.enrollment', learner!, {
        enrollmentId: learner!,
        userId: learner!,
        courseId,
        source: 'FREE',
        orderLineId: null,
        regrant: true,
        grantedAt: new Date().toISOString(),
      }),
    );
    await expect(processor.process(reinstate, regrant)).resolves.toBe('processed');
    expect((await getCourseRatings(pg.db, [courseId]))[0]?.reviewCount).toBe(2);
    expect(await findRatingStatsDrift(pg.db, { courseIds: [courseId] })).toEqual([]);
  }, 30_000);
});
