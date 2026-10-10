// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  EnrollmentSchema,
  ErrorCode,
  ENROLLMENT_ENROLLMENT_AGGREGATE,
} from '@udemy/contracts';
import { type DB, type Kysely, sql } from '@udemy/db';
import { DATABASE } from '@udemy/nest-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type E2eHarness,
  expectProblem,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { playbackRateLimitKey } from '../catalog/infrastructure/redis-playback-rate-limiter';
import { deleteCatalogTestData, insertCatalogTestUser } from '../catalog/testing/catalog-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { EnrollFreeCommand } from './application/use-cases/enroll-free.command';
import { CourseNotFree } from './domain/enrollment.errors';
import { EnrollmentFacade } from './index';
import { freeEnrollmentRateLimitKey } from './infrastructure/redis-free-enrollment-rate-limiter';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  enrollmentIdsOf,
  type PublishedTestCourse,
  publishTestCourse,
  setTestCoursePrice,
} from './testing/enrollment-it';

/*
 * P4-T12 against the integration Postgres + Redis + MinIO through the real AppModule:
 * EnrollmentFacade on the `@udemy/db` grant/revoke SQL (idempotency, the transition log, the
 * deferred status<->log check at COMMIT, outbox events), the row-lock race of concurrent grants
 * (schema doc R4), free enrollment, and THE point of Phase 4 for students: an enrolled student
 * can play a NON-preview lecture of the live revision; everyone else gets 403 lecture_locked.
 */
const V1 = '/api/v1';
const REASON = 'Support case: goodwill access for the student';

describe('enrollment (integration: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const courseIds: string[] = [];
  const categoryIds: string[] = [];
  const usedIps = new Set<string>();
  let fx:
    | {
        admin: SignedUpUser;
        owner: SignedUpUser;
        enrolled: SignedUpUser;
        stranger: SignedUpUser;
        tokens: { enrolled: AuthResult; stranger: AuthResult; owner: AuthResult };
        course: PublishedTestCourse;
        paid: PublishedTestCourse;
      }
    | undefined;

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
  const appDb = (): Kysely<DB> => e2e.app.get<Kysely<DB>>(DATABASE, { strict: false });

  /** A user row for FK-only facade tests (tracked by the harness for cleanup). */
  async function plainUser(label: string): Promise<string> {
    const id = await insertCatalogTestUser(e2e.pg.db, `enroll-${label}`);
    e2e.track(id);
    userIds.push(id);
    return id;
  }

  async function outboxTypes(enrollmentId: string): Promise<string[]> {
    const rows = await e2e.pg.db
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType'])
      .where('aggregateId', '=', enrollmentId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    for (const r of rows) expect(r.aggregateType).toBe(ENROLLMENT_ENROLLMENT_AGGREGATE);
    return rows.map((r) => r.type);
  }

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const enrolled = await e2e.signup();
    const stranger = await e2e.signup();
    for (const u of [owner, enrolled, stranger]) await e2e.verifyEmailViaSql(u.userId);
    userIds.push(admin.userId, owner.userId, enrolled.userId, stranger.userId);
    categoryIds.push(...(await createTestCategory(get, tag)));
    const publish = (title: string) =>
      publishTestCourse(get, e2e.pg.db, s3.storage, {
        ownerId: owner.userId,
        adminId: admin.userId,
        categoryId: categoryIds[0]!,
        title,
      });
    const course = await publish(`Enroll IT ${tag}`);
    const paid = await publish(`Enroll IT paid ${tag}`);
    courseIds.push(course.courseId, paid.courseId);
    await setTestCoursePrice(e2e.pg.db, course.courseId, '0.00', owner.userId);
    await setTestCoursePrice(e2e.pg.db, paid.courseId, '19.99', owner.userId);
    fx = {
      admin,
      owner,
      enrolled,
      stranger,
      tokens: {
        enrolled: await e2e.login('student', enrolled.email),
        stranger: await e2e.login('student', stranger.email),
        owner: await e2e.login('student', owner.email),
      },
      course,
      paid,
    };
  });

  afterAll(async () => {
    if (!available()) return;
    await deleteEnrollmentTestData(e2e.pg.db, { userIds, courseIds });
    const keys = [
      ...[...usedIps].map(playbackRateLimitKey),
      ...userIds.map(freeEnrollmentRateLimitKey),
    ];
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    await deleteMediaTestData(e2e.pg.db, userIds, { storage: s3.storage });
    // The harness deletes the users themselves.
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: userIds, categoryIds, deleteUsers: false });
  });

  /* ------------------------------------------------------------------ facade */

  it('grant -> again -> revoke -> again -> regrant: idempotent, logged, one event per change', async (ctx) => {
    skip(ctx);
    const facade = get(EnrollmentFacade);
    const userId = await plainUser('cycle');
    const admin = fixtures().admin.userId;
    const courseId = randomUUID(); // soft reference: any course id

    const first = await e2e.pg.db
      .transaction()
      .execute((trx) => facade.grant(trx, { userId, courseId, source: 'FREE' }));
    expect(first).toMatchObject({ outcome: 'GRANTED', newlyGranted: true });
    const again = await e2e.pg.db
      .transaction()
      .execute((trx) => facade.grant(trx, { userId, courseId, source: 'FREE' }));
    expect(again).toEqual({
      enrollmentId: first.enrollmentId,
      outcome: 'ALREADY_ACTIVE',
      newlyGranted: false,
    });
    expect(await facade.hasAccess(userId, courseId)).toBe(true);
    expect(await facade.activeCourseIds(userId)).toEqual(new Set([courseId]));

    const revokeInput = {
      userId,
      courseId,
      cause: 'ADMIN' as const,
      actorId: admin,
      reason: REASON,
    };
    const revoked = await e2e.pg.db.transaction().execute((trx) => facade.revoke(trx, revokeInput));
    expect(revoked).toEqual({ enrollmentId: first.enrollmentId, outcome: 'REVOKED' });
    const revokedAgain = await e2e.pg.db
      .transaction()
      .execute((trx) => facade.revoke(trx, revokeInput));
    expect(revokedAgain).toEqual({ enrollmentId: first.enrollmentId, outcome: 'NOT_ACTIVE' });
    expect(await facade.hasAccess(userId, courseId)).toBe(false);
    expect(await facade.activeCourseIds(userId, [courseId])).toEqual(new Set());

    const regrant = await e2e.pg.db.transaction().execute((trx) =>
      facade.grant(trx, {
        userId,
        courseId,
        source: 'ORDER',
        orderLineId: randomUUID(),
      }),
    );
    expect(regrant).toEqual({
      enrollmentId: first.enrollmentId,
      outcome: 'REGRANTED',
      newlyGranted: true,
    });
    expect(await facade.hasAccess(userId, courseId)).toBe(true);

    const log = await e2e.pg.db
      .selectFrom('enrollment.enrollmentTransitions')
      .select(['seq', 'action', 'source', 'revokeReason', 'actorId', 'reason'])
      .where('enrollmentId', '=', first.enrollmentId)
      .orderBy('seq')
      .execute();
    expect(log).toEqual([
      { seq: 1, action: 'GRANT', source: 'FREE', revokeReason: null, actorId: null, reason: null },
      {
        seq: 2,
        action: 'REVOKE',
        source: null,
        revokeReason: 'ADMIN',
        actorId: admin,
        reason: REASON,
      },
      {
        seq: 3,
        action: 'REGRANT',
        source: 'ORDER',
        revokeReason: null,
        actorId: null,
        reason: null,
      },
    ]);
    expect(await outboxTypes(first.enrollmentId)).toEqual([
      'EnrollmentGranted.v1',
      'EnrollmentRevoked.v1',
      'EnrollmentGranted.v1',
    ]);
    const regrantEvent = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('payload')
      .where('aggregateId', '=', first.enrollmentId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(regrantEvent.payload).toMatchObject({ source: 'ORDER', regrant: true });
  });

  it('the event commits with the caller transaction: a rollback leaves no row and no event', async (ctx) => {
    skip(ctx);
    const facade = get(EnrollmentFacade);
    const userId = await plainUser('rollback');
    const courseId = randomUUID();
    await expect(
      e2e.pg.db.transaction().execute(async (trx) => {
        await facade.grant(trx, { userId, courseId, source: 'FREE' });
        throw new Error('the caller fails after the grant');
      }),
    ).rejects.toThrow('the caller fails');
    expect(await facade.hasAccess(userId, courseId)).toBe(false);
    expect(await enrollmentIdsOf(e2e.pg.db, [userId])).toEqual([]);
  });

  it('an ADMIN grant without a reason is refused before SQL (422)', async (ctx) => {
    skip(ctx);
    const facade = get(EnrollmentFacade);
    const userId = await plainUser('noreason');
    await expect(
      e2e.pg.db.transaction().execute((trx) =>
        facade.grant(trx, {
          userId,
          courseId: randomUUID(),
          source: 'ADMIN',
          actorId: fixtures().admin.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
  });

  it('concurrent grants of one (user, course) serialise on the upsert row lock: exactly one wins', async (ctx) => {
    skip(ctx);
    const facade = get(EnrollmentFacade);
    const db = appDb();
    const userId = await plainUser('race');
    const courseId = randomUUID();
    const admin = fixtures().admin.userId;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.transaction().execute(async (trx) => {
          // Every transaction holds a snapshot and a connection before it grants.
          await sql`select pg_sleep(0.05)`.execute(trx);
          return facade.grant(
            trx,
            i % 2 === 0
              ? { userId, courseId, source: 'FREE' }
              : { userId, courseId, source: 'ADMIN', actorId: admin, reason: REASON },
          );
        }),
      ),
    );

    expect(results.filter((r) => r.newlyGranted)).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'ALREADY_ACTIVE')).toHaveLength(7);
    expect(new Set(results.map((r) => r.enrollmentId)).size).toBe(1);
    const id = results[0]!.enrollmentId;
    const transitions = await e2e.pg.db
      .selectFrom('enrollment.enrollmentTransitions')
      .select('seq')
      .where('enrollmentId', '=', id)
      .execute();
    expect(transitions).toEqual([{ seq: 1 }]);
    expect(await outboxTypes(id)).toEqual(['EnrollmentGranted.v1']);
  });

  it('a grant waiting on an uncommitted grant sees ALREADY_ACTIVE once the first commits', async (ctx) => {
    skip(ctx);
    const facade = get(EnrollmentFacade);
    const db = appDb();
    const userId = await plainUser('blocked');
    const courseId = randomUUID();

    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstGranted: () => void = () => undefined;
    const granted = new Promise<void>((resolve) => {
      firstGranted = resolve;
    });
    const first = db.transaction().execute(async (trx) => {
      const r = await facade.grant(trx, { userId, courseId, source: 'FREE' });
      firstGranted();
      await firstHolds; // keep the row lock until the second grant is queued
      return r;
    });
    await granted;
    const second = db
      .transaction()
      .execute((trx) => facade.grant(trx, { userId, courseId, source: 'FREE' }));
    // The second statement is waiting for the first transaction's row lock (pg_locks).
    await expect
      .poll(
        async () =>
          (
            await sql<{ n: number }>`
              select count(*)::int as n from pg_stat_activity
               where wait_event_type = 'Lock' and query like '%enrollment.enrollments%'
                 and datname = current_database() and pid <> pg_backend_pid()`.execute(e2e.pg.db)
          ).rows[0]?.n ?? 0,
        { timeout: 20_000, interval: 50 },
      )
      .toBeGreaterThan(0);
    releaseFirst();
    expect((await first).outcome).toBe('GRANTED');
    expect(await second).toMatchObject({ outcome: 'ALREADY_ACTIVE', newlyGranted: false });
  });

  /* ------------------------------------------------------------------ free enroll */

  it('free enroll: 201 then 200 (idempotent); paid -> 409 course_not_free; no row on refusal', async (ctx) => {
    skip(ctx);
    const { tokens, course, paid, enrolled } = fixtures();
    const student = e2e.as('student', tokens.enrolled.accessToken);
    usedIps.add(e2e.ip());

    const created = await student
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: course.courseId })
      .expect(201);
    const enrollment = EnrollmentSchema.parse(created.body);
    expect(enrollment).toMatchObject({
      userId: enrolled.userId,
      courseId: course.courseId,
      status: 'ACTIVE',
      source: 'FREE',
    });
    const again = await student
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: course.courseId })
      .expect(200);
    expect(again.body).toEqual(created.body);
    expect(await outboxTypes(enrollment.id)).toEqual(['EnrollmentGranted.v1']);

    expectProblem(
      await student.post(`${V1}/me/free-enrollments`).send({ courseId: paid.courseId }),
      409,
      ErrorCode.CourseNotFree,
    );
    await expect(
      get(EnrollFreeCommand).execute({ userId: enrolled.userId, courseId: paid.courseId }),
    ).rejects.toThrow(CourseNotFree);
    // the instructor buys through the student app like everyone else, but not their own course
    expectProblem(
      await e2e
        .as('student', tokens.owner.accessToken)
        .post(`${V1}/me/free-enrollments`)
        .send({ courseId: course.courseId }),
      409,
      ErrorCode.CannotPurchaseOwnCourse,
    );
    expect(await get(EnrollmentFacade).hasAccess(enrolled.userId, paid.courseId)).toBe(false);
  });

  /* ------------------------------------------------------------------ entitlement playback */

  it('an ENROLLED student plays a non-preview lecture of the live revision; others get 403 lecture_locked', async (ctx) => {
    skip(ctx);
    const { tokens, course, enrolled, admin } = fixtures();
    usedIps.add(e2e.ip());
    const master = `${V1}/catalog/courses/${course.courseId}/lectures/${course.lockedVideoId}/hls/master.m3u8`;
    const facade = get(EnrollmentFacade);
    await e2e.pg.db
      .transaction()
      .execute((trx) =>
        facade.grant(trx, { userId: enrolled.userId, courseId: course.courseId, source: 'FREE' }),
      );

    // enrolled: 200 with a real master playlist (Phase 4 rebinding of COURSE_ENTITLEMENTS)
    const ok = await e2e.as('student', tokens.enrolled.accessToken).get(master).expect(200);
    expect(ok.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(ok.text).toContain('#EXTM3U');
    expect(ok.text).toContain('\n360p.m3u8\n');
    await e2e
      .as('student', tokens.enrolled.accessToken)
      .get(master.replace('master.m3u8', '360p.m3u8'))
      .expect(200);

    // not enrolled / anonymous: locked
    expectProblem(
      await e2e.as('student', tokens.stranger.accessToken).get(master),
      403,
      ErrorCode.LectureLocked,
    );
    expectProblem(
      await e2e.http().get(master).set(e2e.client('student')),
      403,
      ErrorCode.LectureLocked,
    );
    // the preview stays open for everyone
    await e2e
      .as('student', tokens.stranger.accessToken)
      .get(master.replace(course.lockedVideoId, course.previewVideoId))
      .expect(200);

    // revoked: locked again (enrollment state is read per request)
    await e2e.pg.db.transaction().execute((trx) =>
      facade.revoke(trx, {
        userId: enrolled.userId,
        courseId: course.courseId,
        cause: 'ADMIN',
        actorId: admin.userId,
        reason: REASON,
      }),
    );
    expectProblem(
      await e2e.as('student', tokens.enrolled.accessToken).get(master),
      403,
      ErrorCode.LectureLocked,
    );
    // and re-granted: open again
    await e2e.pg.db
      .transaction()
      .execute((trx) =>
        facade.grant(trx, { userId: enrolled.userId, courseId: course.courseId, source: 'FREE' }),
      );
    await e2e.as('student', tokens.enrolled.accessToken).get(master).expect(200);
  });
});
