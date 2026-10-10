import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type DB, type Kysely, sql, type Transaction } from '@udemy/db';
import { deleteTestUsers } from '../../../testing/integration';
import { commerceRateLimitKeys } from '../infrastructure/redis-commerce-rate-limiter';

/**
 * Integration/e2e support for commerce (IT conventions of `src/testing/integration.ts`): every
 * file owns its data and removes it in `afterAll`.
 *
 * Commerce only reads courses through `CatalogFacade.getCourseSummaries` (a live revision and
 * its title), so test courses are written straight into the catalog tables in replica mode
 * (no lifecycle triggers, no FKs to categories/assets): fast, and no MinIO needed. The
 * catalog's own suites cover the real submit/approve path. Needs a superuser, like every
 * cleanup helper here.
 */

export type TestCourseStatus = 'PUBLISHED' | 'ARCHIVED' | 'DRAFT';

export interface TestCourse {
  readonly courseId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly slug: string;
}

/** A user row (FK target of carts, prices, coupons) without going through signup. */
export async function insertCommerceTestUser(db: Kysely<DB>, label: string): Promise<string> {
  const row = await db
    .insertInto('identity.users')
    .values({
      email: `commerce-it-${label}-${randomUUID().slice(0, 12)}@example.test`,
      displayName: `Commerce IT ${label}`,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$bm90LWEtcmVhbC1oYXNo$bm90LWEtcmVhbC1oYXNo',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * A course in `status`: PUBLISHED / ARCHIVED with a live revision (its title is what the cart
 * shows), DRAFT without one (unknown to the catalog facade).
 */
export async function insertTestCourse(
  db: Kysely<DB>,
  options: { ownerId: string; status?: TestCourseStatus; title?: string },
): Promise<TestCourse> {
  const status = options.status ?? 'PUBLISHED';
  const suffix = randomUUID().slice(0, 8);
  const title = options.title ?? `Commerce course ${suffix}`;
  const slug = `commerce-it-${suffix}`;
  const courseId = await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    const course = await trx
      .insertInto('catalog.courses')
      .values({ ownerId: options.ownerId, slug, title: `Draft of ${title}`.slice(0, 60) })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (status === 'DRAFT') return course.id;
    const revision = await trx
      .insertInto('catalog.courseRevisions')
      .values({
        courseId: course.id,
        revisionNo: 1,
        kind: 'INITIAL',
        contentHash: randomBytes(32),
        title,
        subtitle: 'A subtitle for commerce tests',
        descriptionMd: 'x'.repeat(220),
        language: 'en',
        level: 'BEGINNER',
        categoryId: randomUUID(),
        thumbnailAssetId: randomUUID(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      UPDATE catalog.courses
         SET status = ${status}, published_revision_id = ${revision.id}, first_published_at = now()
       WHERE id = ${course.id}
    `.execute(trx);
    return course.id;
  });
  return { courseId, ownerId: options.ownerId, title, slug };
}

/** Moves a test course to another status (e.g. archive after it was added to a cart). */
export async function setTestCourseStatus(
  db: Kysely<DB>,
  courseId: string,
  status: 'PUBLISHED' | 'ARCHIVED',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`UPDATE catalog.courses SET status = ${status} WHERE id = ${courseId}`.execute(trx);
  });
}

/** Sets a price as SetCoursePrice would (the history trigger records it). */
export async function setTestPrice(
  db: Kysely<DB>,
  courseId: string,
  amount: string,
  updatedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO commerce.course_prices AS p (course_id, amount, currency, updated_by)
    VALUES (${courseId}, ${amount}::numeric, 'USD', ${updatedBy})
    ON CONFLICT (course_id) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by
     WHERE p.amount IS DISTINCT FROM EXCLUDED.amount
  `.execute(db);
}

/** A unique, valid coupon code (`^[A-Z0-9_-]{4,20}$`). */
export function testCouponCode(prefix = 'IT'): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`.toUpperCase().slice(0, 20);
}

export interface TestCouponOptions {
  readonly createdBy: string;
  /** Omitted = PLATFORM. */
  readonly courseId?: string;
  readonly code: string;
  readonly percentOff?: number;
  /** AMOUNT (course coupons only). */
  readonly amountOff?: string;
  readonly maxRedemptions?: number | null;
  /** Default: started a minute ago, running 7 days. */
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly deactivated?: boolean;
}

/**
 * A coupon row written directly (any window the CHECKs allow, e.g. already expired or not
 * started), bypassing CreateCourseCoupon's "ends in the future" rule.
 */
export async function insertTestCoupon(
  db: Kysely<DB>,
  options: TestCouponOptions,
): Promise<string> {
  const amount = options.amountOff !== undefined;
  const startsAt = options.startsAt ?? new Date(Date.now() - 60_000);
  const endsAt = options.endsAt ?? new Date(startsAt.getTime() + 7 * 86_400_000);
  const row = await db
    .insertInto('commerce.coupons')
    .values({
      scope: options.courseId === undefined ? 'PLATFORM' : 'COURSE',
      courseId: options.courseId ?? null,
      code: options.code,
      discountType: amount ? 'AMOUNT' : 'PERCENT',
      percentOff: amount ? null : (options.percentOff ?? 50),
      amountOff: options.amountOff ?? null,
      currency: amount ? 'USD' : null,
      startsAt,
      endsAt,
      maxRedemptions: options.maxRedemptions ?? null,
      createdBy: options.createdBy,
      deactivatedAt: options.deactivated === true ? sql<Date>`now()` : null,
      deactivatedBy: options.deactivated === true ? options.createdBy : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * A redemption of `couponId` by `userId` on a synthetic order (replica mode: no reservation
 * trigger, no deferred order checks). RESERVED sits on an EXPIRED order (so it never blocks the
 * user's one open checkout), CONSUMED on a PAID one; both count against `max_redemptions`.
 */
export async function insertTestRedemption(
  db: Kysely<DB>,
  options: { couponId: string; userId: string; status: 'RESERVED' | 'CONSUMED' },
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    const paid = options.status === 'CONSUMED';
    const { rows } = await sql<{ id: string }>`
      INSERT INTO commerce.orders (user_id, status, currency, total_amount, idempotency_key,
                                   request_fingerprint, paid_at, closed_at)
      VALUES (${options.userId}, ${paid ? 'PAID' : 'EXPIRED'}, 'USD', 10.00, ${randomUUID()},
              ${createHash('sha256').update(randomUUID()).digest()},
              ${paid ? sql`now()` : null}, ${paid ? null : sql`now()`})
      RETURNING id
    `.execute(trx);
    const orderId = rows[0]?.id;
    if (orderId === undefined) throw new Error('order insert returned nothing');
    await sql`
      INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status, consumed_at)
      VALUES (${orderId}, ${options.couponId}, ${options.userId}, ${options.status},
              ${paid ? sql`now()` : null})
    `.execute(trx);
    return orderId;
  });
}

/** An ACTIVE enrollment written directly (the enrollment module's own suites cover grant). */
export async function insertTestEnrollment(
  db: Kysely<DB>,
  userId: string,
  courseId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`
      INSERT INTO enrollment.enrollments (user_id, course_id, source) VALUES (${userId}, ${courseId}, 'FREE')
    `.execute(trx);
  });
}

/**
 * The children of the users' orders (P4-T15/T16 tables), inside the caller's replica-mode
 * transaction: payouts entries of their lines (if a worker ever ran), refunds and their
 * transitions, provider events, order transitions, payments, lines and the orders' outbox
 * events. The orders themselves are deleted by the caller.
 */
async function deleteOrdersOf(trx: Transaction<DB>, users: readonly string[]): Promise<void> {
  const orderIds = (
    await trx
      .selectFrom('commerce.orders')
      .select('id')
      .where('userId', 'in', [...users])
      .execute()
  ).map((r) => r.id);
  if (orderIds.length === 0) return;
  const lineIds = (
    await trx
      .selectFrom('commerce.orderLines')
      .select('id')
      .where('orderId', 'in', orderIds)
      .execute()
  ).map((r) => r.id);
  if (lineIds.length > 0) {
    const entryIds = (
      await trx
        .selectFrom('payouts.journalEntries')
        .select('id')
        .where('orderLineId', 'in', lineIds)
        .execute()
    ).map((r) => r.id);
    if (entryIds.length > 0) {
      await trx.deleteFrom('payouts.postings').where('entryId', 'in', entryIds).execute();
      await trx.deleteFrom('payouts.journalEntries').where('id', 'in', entryIds).execute();
    }
  }
  const refundIds = (
    await trx.selectFrom('commerce.refunds').select('id').where('orderId', 'in', orderIds).execute()
  ).map((r) => r.id);
  if (refundIds.length > 0) {
    await trx.deleteFrom('commerce.refundTransitions').where('refundId', 'in', refundIds).execute();
    await trx.deleteFrom('commerce.refunds').where('id', 'in', refundIds).execute();
  }
  await trx.deleteFrom('commerce.orderTransitions').where('orderId', 'in', orderIds).execute();
  await trx.deleteFrom('commerce.providerEvents').where('orderId', 'in', orderIds).execute();
  await trx.deleteFrom('commerce.payments').where('orderId', 'in', orderIds).execute();
  await trx.deleteFrom('commerce.orderLines').where('orderId', 'in', orderIds).execute();
  await trx.deleteFrom('outbox.events').where('aggregateId', 'in', orderIds).execute();
}

/**
 * Removes provider events by id (the ones a test sent that never mapped to an order: orphans,
 * ignored types, livemode). Replica mode bypasses the inbox's no-delete guard.
 */
export async function deleteProviderEvents(
  db: Kysely<DB>,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await trx
      .deleteFrom('commerce.providerEvents')
      .where('provider', '=', 'STRIPE')
      .where('eventId', 'in', [...eventIds])
      .execute();
  });
}

/** Clears the commerce rate-limit buckets these tests may have filled. */
export function commerceRateLimitTestKeys(options: {
  userIds?: readonly string[];
  courseIds?: readonly string[];
  ips?: readonly string[];
}): string[] {
  return [
    ...(options.userIds ?? []).flatMap((u) => [
      commerceRateLimitKeys.cartWrite(u),
      commerceRateLimitKeys.couponApplyUser(u),
      commerceRateLimitKeys.couponCreate(u),
      commerceRateLimitKeys.checkout(u),
      commerceRateLimitKeys.refundRequest(u),
    ]),
    ...(options.courseIds ?? []).map((c) => commerceRateLimitKeys.priceChange(c)),
    ...(options.ips ?? []).map((ip) => commerceRateLimitKeys.couponApplyIp(ip)),
  ];
}

/**
 * Removes everything commerce tests wrote for these users and courses: carts, coupons (of the
 * courses and created by the users) with their redemptions and synthetic orders, prices with
 * their append-only history, enrollments, the outbox events of courses and coupons, the test
 * courses, and (unless `deleteUsers: false`) the users. Replica mode disables the append-only
 * guards and also ON DELETE CASCADE, so children go first.
 */
export async function deleteCommerceTestData(
  db: Kysely<DB>,
  options: { userIds: readonly string[]; courseIds: readonly string[]; deleteUsers?: boolean },
): Promise<void> {
  const users = [...new Set(options.userIds)];
  const courses = [...new Set(options.courseIds)];
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    const couponIds = (
      await trx
        .selectFrom('commerce.coupons')
        .select('id')
        .where((eb) =>
          eb.or([
            ...(courses.length > 0 ? [eb('courseId', 'in', courses)] : []),
            ...(users.length > 0 ? [eb('createdBy', 'in', users)] : []),
            eb.val(false),
          ]),
        )
        .execute()
    ).map((r) => r.id);
    if (couponIds.length > 0) {
      await trx
        .deleteFrom('commerce.couponRedemptions')
        .where('couponId', 'in', couponIds)
        .execute();
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', couponIds).execute();
    }
    if (users.length > 0) {
      await deleteOrdersOf(trx, users);
      await trx.deleteFrom('commerce.couponRedemptions').where('userId', 'in', users).execute();
      await trx.deleteFrom('commerce.orders').where('userId', 'in', users).execute();
      await trx.deleteFrom('commerce.cartItems').where('userId', 'in', users).execute();
      await trx.deleteFrom('commerce.carts').where('userId', 'in', users).execute();
      const enrollmentIds = (
        await trx
          .selectFrom('enrollment.enrollments')
          .select('id')
          .where('userId', 'in', users)
          .execute()
      ).map((r) => r.id);
      if (enrollmentIds.length > 0) {
        await trx.deleteFrom('outbox.events').where('aggregateId', 'in', enrollmentIds).execute();
        await trx
          .deleteFrom('enrollment.enrollmentTransitions')
          .where('enrollmentId', 'in', enrollmentIds)
          .execute();
      }
      await trx.deleteFrom('enrollment.enrollments').where('userId', 'in', users).execute();
    }
    if (couponIds.length > 0) {
      await trx.deleteFrom('commerce.coupons').where('id', 'in', couponIds).execute();
    }
    if (courses.length > 0) {
      await trx.deleteFrom('commerce.cartItems').where('courseId', 'in', courses).execute();
      await trx
        .deleteFrom('commerce.coursePriceChanges')
        .where('courseId', 'in', courses)
        .execute();
      await trx.deleteFrom('commerce.coursePrices').where('courseId', 'in', courses).execute();
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', courses).execute();
      await trx.deleteFrom('catalog.courseRevisions').where('courseId', 'in', courses).execute();
      await trx.deleteFrom('catalog.courses').where('id', 'in', courses).execute();
    }
  });
  if (options.deleteUsers !== false) await deleteTestUsers(db, users);
}
