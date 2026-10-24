// Must stay the first import: AppModule validates process.env when it is imported. The commerce
// e2e env = the catalog-public env (1-lecture readiness, MinIO) + an allowed checkout origin.
import { COMMERCE_E2E_ENV } from './testing/apply-commerce-e2e-env';
import { createHash, randomUUID } from 'node:crypto';
import {
  AdminRefundQueueItemSchema,
  ErrorCode,
  OrderDetailSchema,
  type OrderLine,
} from '@udemy/contracts';
import { issueCertificate, sql } from '@udemy/db';
import { PAYMENT_PROVIDER, type ProviderEvent, parseProviderEvent } from '@udemy/payments';
import { InMemoryPaymentProvider } from '@udemy/payments/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type E2eHarness, type SignedUpUser, useE2eApp } from '../../testing/e2e/e2e-harness';
import { CatalogFacade, type LiveCurriculum } from '../catalog';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
  setTestCoursePrice,
} from '../enrollment/testing/enrollment-it';
import { CompletionRecorder } from '../learning/application/completion-recorder';
import { deleteLearningTestData } from '../learning/testing/learning-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { CheckoutCommand } from './application/use-cases/checkout.command';
import { GetAdminOrderQuery } from './application/use-cases/get-admin-order.query';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetMyOrderQuery } from './application/use-cases/get-my-order.query';
import { HandleProviderEventCommand } from './application/use-cases/handle-provider-event.command';
import { ListRefundQueueQuery } from './application/use-cases/list-refund-queue.query';
import { RequestRefundCommand } from './application/use-cases/request-refund.command';
import { ReviewRefundCommand } from './application/use-cases/review-refund.command';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
} from './testing/commerce-it';

/*
 * P5-T16 (learning design D8, P5-D6) against Postgres + Redis + MinIO through the real AppModule:
 * the bound `LearningConsumptionPolicy` reads REAL learning facts (lecture completions written by
 * `CompletionRecorder`, a `lecture_progress` bitmap of the live video asset, a certificate issued
 * with `@udemy/db` `issueCertificate`) for a course published through the catalog use cases, and
 * a student refund request of a PAID order line:
 *
 * - nothing consumed -> APPROVED at once, access revoked at approval (Phase 4 unchanged);
 * - > 30% of the live lectures completed -> REQUESTED, `consumed_lectures_50` recorded on the
 *   first refund transition, visible as `reviewReason` (queue, admin order) with the live
 *   figures; access kept until an admin approves (then revoked: the granting line);
 * - > 30% of the live video seconds watched -> REQUESTED with `consumed_video_50`;
 * - an ACTIVE certificate -> REQUESTED with `certificate_issued` (first in the order);
 * - the buyer's order detail shows the consumption on the refundable line (the dialog hint).
 *
 * The provider is `InMemoryPaymentProvider` (checkout urls on the allowed emulator origin);
 * events are handed to `HandleProviderEventCommand` directly.
 */
const CHECKOUT_BASE = `${COMMERCE_E2E_ENV.emulatorUrl}/pay/`;

describe('refund consumption review (integration: AppModule, Postgres, Redis, MinIO)', () => {
  const provider = new InMemoryPaymentProvider({ checkoutBaseUrl: CHECKOUT_BASE });
  const e2e: E2eHarness = useE2eApp({
    overrides: [{ provide: PAYMENT_PROVIDER, useValue: provider }],
  });
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const courseIds: string[] = [];
  const categoryIds: string[] = [];
  const eventIds: string[] = [];
  let fx: { admin: SignedUpUser; course: PublishedTestCourse } | undefined;

  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });
  const fixtures = () => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };

  async function buyer(): Promise<string> {
    const u = await e2e.signup();
    await e2e.verifyEmailViaSql(u.userId);
    userIds.push(u.userId);
    return u.userId;
  }

  async function deliver(json: object): Promise<void> {
    const raw = Buffer.from(JSON.stringify(json), 'utf8');
    const event: ProviderEvent = parseProviderEvent(raw);
    eventIds.push(event.id);
    const result = await get(HandleProviderEventCommand).execute(
      event,
      createHash('sha256').update(raw).digest(),
      'WEBHOOK',
    );
    expect(result.outcome).toBe('APPLIED');
  }

  /** Cart -> checkout -> the provider completes the session -> PAID (enrolled by the line). */
  async function buy(userId: string): Promise<{ orderId: string; line: OrderLine }> {
    const courseId = fixtures().course.courseId;
    await get(AddToCartCommand).execute({ userId, courseId });
    const placed = await get(CheckoutCommand).execute({
      userId,
      idempotencyKey: randomUUID(),
      expectedTotal: (await get(GetCartQuery).execute(userId)).totals.totalAmount,
    });
    const sessionId = (placed.checkoutUrl ?? '').slice(CHECKOUT_BASE.length);
    provider.completeSession(sessionId);
    await deliver(provider.checkoutCompletedEvent(sessionId));
    const detail = await get(GetMyOrderQuery).execute({ userId, orderId: placed.orderId });
    const line = detail.lines[0];
    if (line === undefined) throw new Error('no order line');
    return { orderId: placed.orderId, line };
  }

  async function curriculum(): Promise<LiveCurriculum> {
    const live = await get(CatalogFacade).getLiveCurriculum(fixtures().course.courseId);
    if (live === null) throw new Error('the test course has no live curriculum');
    return live;
  }

  /** Completes live lectures the way learning does (outbox, course completion when all). */
  async function complete(userId: string, count: number): Promise<void> {
    const live = await curriculum();
    const lectures = live.sections.flatMap((s) => s.lectures).slice(0, count);
    for (const lecture of lectures) {
      await e2e.pg.db.transaction().execute((trx) =>
        get(CompletionRecorder).complete(trx, {
          userId,
          curriculum: live,
          lecture,
          cause: 'VIDEO_WATCHED',
        }),
      );
    }
  }

  /** A fully covered bitmap of the FIRST live video, measured against its live asset. */
  async function watchFirstVideo(userId: string): Promise<void> {
    const live = await curriculum();
    const video = live.sections.flatMap((s) => s.lectures).find((l) => l.type === 'VIDEO');
    if (video?.durationSeconds == null || video.mediaAssetId === null) {
      throw new Error('the test course has no live video');
    }
    const bits = '1'.repeat(Math.ceil(video.durationSeconds / 5));
    await sql`
      INSERT INTO learning.lecture_progress
        (user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds,
         coverage, first_watched_at, last_watched_at)
      VALUES (${userId}, ${video.id}, ${live.courseId}, ${video.mediaAssetId},
              ${video.durationSeconds}, ${video.durationSeconds}, ${bits}::varbit, now(), now())
    `.execute(e2e.pg.db);
  }

  async function certify(userId: string): Promise<void> {
    await complete(userId, Number.MAX_SAFE_INTEGER);
    const live = await curriculum();
    await e2e.pg.db.transaction().execute(async (trx) => {
      const result = await issueCertificate(trx, {
        userId,
        courseId: live.courseId,
        revisionId: live.liveRevisionId,
        // hex is a subset of Crockford base32
        publicCode: randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase(),
        recipientName: 'Refund Tester',
        courseTitle: live.title.slice(0, 60),
        instructorName: 'Owner',
        sourceEventId: randomUUID(),
      });
      expect(result.outcome).toBe('ISSUED');
    });
  }

  async function firstTransitionReason(refundId: string): Promise<string | null> {
    const row = await e2e.pg.db
      .selectFrom('commerce.refundTransitions')
      .select(['reason', 'actorId', 'toStatus'])
      .where('refundId', '=', refundId)
      .where('seq', '=', 1)
      .executeTakeFirstOrThrow();
    return row.reason;
  }

  async function enrollmentStatus(userId: string): Promise<string | null> {
    const row = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select('status')
      .where('userId', '=', userId)
      .where('courseId', '=', fixtures().course.courseId)
      .executeTakeFirst();
    return row?.status ?? null;
  }

  const request = (userId: string, orderId: string, line: OrderLine) =>
    get(RequestRefundCommand).execute({
      userId,
      orderId,
      orderLineId: line.id,
      reasonCode: 'NOT_AS_EXPECTED',
    });

  async function queueItemOf(refundId: string) {
    let cursor: string | undefined;
    for (;;) {
      const page = await get(ListRefundQueueQuery).execute({
        status: 'REQUESTED',
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const found = page.items.find((i) => i.id === refundId);
      if (found !== undefined) return AdminRefundQueueItemSchema.parse(found);
      if (page.nextCursor === null) throw new Error(`refund ${refundId} not in the queue`);
      cursor = page.nextCursor;
    }
  }

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    await e2e.verifyEmailViaSql(owner.userId);
    userIds.push(admin.userId, owner.userId);
    categoryIds.push(...(await createTestCategory(get, `rfc-${tag}`)));
    const course = await publishTestCourse(get, e2e.pg.db, s3.storage, {
      ownerId: owner.userId,
      adminId: admin.userId,
      categoryId: categoryIds[0] ?? '',
      title: `Refund consumption ${tag}`,
    });
    courseIds.push(course.courseId);
    await setTestCoursePrice(e2e.pg.db, course.courseId, '19.99', owner.userId);
    fx = { admin, course };
  });

  beforeEach(async () => {
    if (!available()) return;
    const keys = commerceRateLimitTestKeys({ userIds });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
  });

  afterAll(async () => {
    if (!available()) return;
    const keys = commerceRateLimitTestKeys({ userIds, courseIds });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    await e2e.pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      const certificateIds = (
        await trx
          .selectFrom('learning.certificates')
          .select('id')
          .where('userId', 'in', userIds)
          .execute()
      ).map((c) => c.id);
      if (certificateIds.length > 0) {
        await trx
          .deleteFrom('learning.certificateTransitions')
          .where('certificateId', 'in', certificateIds)
          .execute();
        await trx.deleteFrom('learning.certificates').where('id', 'in', certificateIds).execute();
      }
    });
    await deleteLearningTestData(e2e.pg.db, userIds);
    await deleteCommerceTestData(e2e.pg.db, { userIds, courseIds: [], deleteUsers: false });
    await deleteProviderEvents(e2e.pg.db, eventIds);
    // the course prices (orders, carts and enrollments went with deleteCommerceTestData)
    await deleteEnrollmentTestData(e2e.pg.db, { userIds, courseIds });
    await deleteMediaTestData(e2e.pg.db, userIds, { storage: s3.storage });
    // The harness deletes the users themselves.
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: userIds, categoryIds, deleteUsers: false });
  });

  it('nothing consumed: APPROVED at once and revoked at approval (Phase 4 unchanged); the line showed 0%', async (ctx) => {
    skip(ctx);
    const userId = await buyer();
    const { orderId, line } = await buy(userId);
    expect(line.refund.eligible).toBe(true);
    expect(line.consumption).toMatchObject({
      videoPct: 0,
      lecturesPct: 0,
      completedLectures: 0,
      certificateStatus: null,
      reviewReason: null,
    });
    expect(line.consumption?.totalLectures).toBeGreaterThan(0);

    const refund = await request(userId, orderId, line);
    expect(refund.status).toBe('APPROVED');
    expect(await firstTransitionReason(refund.id)).toBeNull();
    expect(await enrollmentStatus(userId)).toBe('REVOKED');

    // a refunded line is no longer refundable: no consumption on it
    const after = OrderDetailSchema.parse(await get(GetMyOrderQuery).execute({ userId, orderId }));
    expect(after.lines[0]?.consumption).toBeNull();
  });

  it('> 30% of the live lectures completed: REQUESTED with consumed_lectures_50 recorded and shown; admin approve revokes the granting line', async (ctx) => {
    skip(ctx);
    const userId = await buyer();
    const { orderId } = await buy(userId);
    await complete(userId, 1); // 1 of the 2 live lectures

    const detail = OrderDetailSchema.parse(await get(GetMyOrderQuery).execute({ userId, orderId }));
    const line = detail.lines[0];
    if (line === undefined) throw new Error('no line');
    expect(line.consumption).toMatchObject({
      completedLectures: 1,
      totalLectures: 2,
      lecturesPct: 50,
      reviewReason: 'consumed_lectures_50',
    });

    const refund = await request(userId, orderId, line);
    expect(refund.status).toBe('REQUESTED');
    expect(await firstTransitionReason(refund.id)).toBe('consumed_lectures_50');
    expect(await enrollmentStatus(userId)).toBe('ACTIVE');

    const item = await queueItemOf(refund.id);
    expect(item).toMatchObject({
      reviewReason: 'consumed_lectures_50',
      recentRefundCount: 0,
      consumption: { completedLectures: 1, totalLectures: 2, reviewReason: 'consumed_lectures_50' },
    });
    const admin = await get(GetAdminOrderQuery).execute(orderId);
    expect(admin.refunds[0]).toMatchObject({ id: refund.id, reviewReason: 'consumed_lectures_50' });
    expect(admin.refunds[0]?.transitions[0]).toMatchObject({
      toStatus: 'REQUESTED',
      actorId: userId,
      reason: 'consumed_lectures_50',
    });

    const approved = await get(ReviewRefundCommand).execute({
      adminId: fixtures().admin.userId,
      refundId: refund.id,
      decision: 'approve',
      reason: 'Reviewed the consumption; approved.',
    });
    expect(approved).toMatchObject({ status: 'APPROVED', reviewReason: 'consumed_lectures_50' });
    // progress is kept after the refund (D9), so the figures stay readable
    expect(approved.consumption.completedLectures).toBe(1);
    expect(await enrollmentStatus(userId)).toBe('REVOKED');
  });

  it('> 30% of the live video seconds watched: REQUESTED with consumed_video_50', async (ctx) => {
    skip(ctx);
    const userId = await buyer();
    const { orderId, line } = await buy(userId);
    await watchFirstVideo(userId); // one of two equal live videos, fully covered

    const refund = await request(userId, orderId, line);
    expect(refund.status).toBe('REQUESTED');
    expect(await firstTransitionReason(refund.id)).toBe('consumed_video_50');
    const item = await queueItemOf(refund.id);
    expect(item.consumption).toMatchObject({ videoPct: 50, completedLectures: 0 });
    expect(item.reviewReason).toBe('consumed_video_50');
  });

  it('an ACTIVE certificate: REQUESTED with certificate_issued (checked first); a reject keeps access', async (ctx) => {
    skip(ctx);
    const userId = await buyer();
    const { orderId, line } = await buy(userId);
    await certify(userId);

    const refund = await request(userId, orderId, line);
    expect(refund.status).toBe('REQUESTED');
    expect(await firstTransitionReason(refund.id)).toBe('certificate_issued');
    const item = await queueItemOf(refund.id);
    expect(item.consumption).toMatchObject({
      certificateStatus: 'ACTIVE',
      lecturesPct: 100,
      reviewReason: 'certificate_issued',
    });
    expect(item.consumption.courseCompletedAt).not.toBeNull();

    const rejected = await get(ReviewRefundCommand).execute({
      adminId: fixtures().admin.userId,
      refundId: refund.id,
      decision: 'reject',
      reason: 'The course was completed and certified.',
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', reviewReason: 'certificate_issued' });
    expect(await enrollmentStatus(userId)).toBe('ACTIVE');
    // a second request is evaluated again (still certified): REQUESTED once more, never blocked
    const again = await request(userId, orderId, line);
    expect(again.status).toBe('REQUESTED');
    await expect(request(userId, orderId, line)).rejects.toMatchObject({
      code: ErrorCode.RefundAlreadyRequested,
    });
  });
});
