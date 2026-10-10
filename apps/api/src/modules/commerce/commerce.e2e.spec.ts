// Must stay the first import: AppModule validates process.env when it is imported.
import '../../testing/e2e/apply-e2e-app-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  CartQuoteSchema,
  CouponPageSchema,
  CouponSchema,
  CoursePricingSchema,
  ErrorCode,
  MergeGuestCartResponseSchema,
  PUBLIC_PRICES_CACHE_CONTROL,
  PublicPricesResponseSchema,
  PurchaseStatesResponseSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { SECTION_8_PHASE_4_COMMERCE_A } from '../../testing/e2e/section-8';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  insertTestCoupon,
  insertTestCourse,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T13 routes (design §8) through the REAL AppModule: the four global guards in production
 * order, the route markers, validation, problem+json, Postgres and Redis.
 *
 * The auth matrix runs every in-scope route for: anonymous (student BFF client credentials, no
 * session), a student (student app), the course owner and another instructor (instructor
 * app), and an admin (admin app). Permissions are app-scoped (D6), so the cart is
 * student-app only, pricing/coupons are instructor-app (admins read), platform coupons are
 * admin-only, and a foreign course is 404, never 403 (§9 IDOR).
 */
const V1 = '/api/v1';
const DAY = 86_400_000;

type Actor = 'anonymous' | 'student' | 'owner' | 'other' | 'admin';
const ACTORS: readonly Actor[] = ['anonymous', 'student', 'owner', 'other', 'admin'];

interface Route {
  readonly method: HttpMethod;
  /** OpenAPI path (as in SECTION_8). */
  readonly template: string;
  readonly path: () => string;
  readonly body?: () => object;
  /** Status per actor; allowed actors run LAST (state-changing routes). */
  readonly expect: Readonly<Record<Actor, number>>;
  /** Parses the success body with its contracts schema. */
  readonly schema?: z.ZodType;
}

interface Fixtures {
  users: { student: SignedUpUser; owner: SignedUpUser; other: SignedUpUser; admin: SignedUpUser };
  tokens: Record<Exclude<Actor, 'anonymous'>, AuthResult>;
  /** The owner's paid course (19.99), and the other instructor's. */
  course: TestCourse;
  otherCourse: TestCourse;
  /** A second paid course of the owner, for the cart routes. */
  cartCourse: TestCourse;
  /** A course coupon of `course` and a platform coupon (for the deactivate routes). */
  couponId: string;
  platformCouponId: string;
  /** A valid code for `cartCourse`. */
  cartCode: string;
}

describe('commerce A endpoints (e2e: AppModule, guards, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  const courseIds: string[] = [];
  const usedIps = new Set<string>();
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };

  async function newCourse(ownerId: string, price: string | null): Promise<TestCourse> {
    const course = await insertTestCourse(e2e.pg.db, { ownerId });
    courseIds.push(course.courseId);
    if (price !== null) await setTestPrice(e2e.pg.db, course.courseId, price, ownerId);
    return course;
  }

  function bearer(actor: Exclude<Actor, 'anonymous'>): BearerClient {
    usedIps.add(e2e.ip());
    const { tokens } = fixtures();
    const app = actor === 'student' ? 'student' : actor === 'admin' ? 'admin' : 'instructor';
    return e2e.as(app, tokens[actor].accessToken);
  }

  function call(actor: Actor, method: HttpMethod, path: string): request.Test {
    if (actor === 'anonymous') {
      usedIps.add(e2e.ip());
      return e2e.http()[method](path).set(e2e.client('student'));
    }
    return bearer(actor).call(method, path);
  }

  beforeAll(async () => {
    if (!e2e.pg.available || !e2e.redis.available) return;
    const admin = await e2e.bootstrapAdmin();
    const student = await e2e.signup({ displayName: 'Commerce student' });
    const owner = await e2e.signup({ displayName: 'Commerce owner' });
    const other = await e2e.signup({ displayName: 'Commerce other' });
    for (const u of [student, owner, other]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    await e2e.promoteToInstructor(other.userId, admin.userId);
    const course = await newCourse(owner.userId, '19.99');
    const otherCourse = await newCourse(other.userId, '24.99');
    const cartCourse = await newCourse(owner.userId, '49.99');
    const couponId = await insertTestCoupon(e2e.pg.db, {
      createdBy: owner.userId,
      courseId: course.courseId,
      code: testCouponCode('E2E'),
    });
    const platformCouponId = await insertTestCoupon(e2e.pg.db, {
      createdBy: admin.userId,
      code: testCouponCode('E2EP'),
    });
    const cartCode = testCouponCode('CART');
    await insertTestCoupon(e2e.pg.db, {
      createdBy: owner.userId,
      courseId: cartCourse.courseId,
      code: cartCode,
      percentOff: 10,
    });
    fx = {
      users: { student, owner, other, admin },
      tokens: {
        student: await e2e.login('student', student.email),
        owner: await e2e.login('instructor', owner.email),
        other: await e2e.login('instructor', other.email),
        admin: await e2e.login('admin', admin.email),
      },
      course,
      otherCourse,
      cartCourse,
      couponId,
      platformCouponId,
      cartCode,
    };
  });

  afterAll(async () => {
    if (!e2e.pg.available || !e2e.redis.available || fx === undefined) return;
    const userIds = Object.values(fx.users).map((u) => u.userId);
    const keys = commerceRateLimitTestKeys({ userIds, courseIds, ips: [...usedIps] });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    // The harness deletes the users afterwards (its afterAll runs after this one).
    await deleteCommerceTestData(e2e.pg.db, { userIds, courseIds, deleteUsers: false });
  });

  const couponBody = () => ({
    code: testCouponCode('NEW'),
    discountType: 'PERCENT',
    percentOff: 15,
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
  });

  /** Every in-scope §8 route with its expected status per actor. */
  const routes = (): Route[] => {
    const { course, cartCourse, couponId, platformCouponId, cartCode } = fixtures();
    const c = course.courseId;
    const student = { anonymous: 401, student: 200, owner: 403, other: 403, admin: 403 } as const;
    const read = { anonymous: 401, student: 403, owner: 200, other: 404, admin: 200 } as const;
    const write = { anonymous: 401, student: 403, owner: 200, other: 404, admin: 403 } as const;
    const adminOnly = { anonymous: 401, student: 403, owner: 403, other: 403, admin: 200 } as const;
    return [
      {
        method: 'get',
        template: `${V1}/commerce/prices`,
        path: () => `${V1}/commerce/prices?courseIds=${c},${cartCourse.courseId}`,
        expect: { anonymous: 200, student: 200, owner: 200, other: 200, admin: 200 },
        schema: PublicPricesResponseSchema,
      },
      {
        method: 'get',
        template: `${V1}/me/cart`,
        path: () => `${V1}/me/cart`,
        expect: student,
        schema: CartQuoteSchema,
      },
      {
        method: 'put',
        template: `${V1}/me/cart/items/{courseId}`,
        path: () => `${V1}/me/cart/items/${cartCourse.courseId}`,
        expect: student,
        schema: CartQuoteSchema,
      },
      {
        method: 'put',
        template: `${V1}/me/cart/coupon`,
        path: () => `${V1}/me/cart/coupon`,
        body: () => ({ code: cartCode.toLowerCase() }),
        expect: student,
        schema: CartQuoteSchema,
      },
      {
        method: 'delete',
        template: `${V1}/me/cart/coupon`,
        path: () => `${V1}/me/cart/coupon`,
        expect: student,
        schema: CartQuoteSchema,
      },
      {
        method: 'post',
        template: `${V1}/me/cart/merge`,
        path: () => `${V1}/me/cart/merge`,
        body: () => ({ courseIds: [c, randomUUID()] }),
        expect: student,
        schema: MergeGuestCartResponseSchema,
      },
      {
        method: 'delete',
        template: `${V1}/me/cart/items/{courseId}`,
        path: () => `${V1}/me/cart/items/${c}`,
        expect: student,
        schema: CartQuoteSchema,
      },
      {
        method: 'get',
        template: `${V1}/me/purchase-states`,
        path: () => `${V1}/me/purchase-states?courseIds=${c}&courseIds=${cartCourse.courseId}`,
        expect: student,
        schema: PurchaseStatesResponseSchema,
      },
      {
        method: 'get',
        template: `${V1}/courses/{courseId}/pricing`,
        path: () => `${V1}/courses/${c}/pricing`,
        expect: read,
        schema: CoursePricingSchema,
      },
      {
        method: 'put',
        template: `${V1}/courses/{courseId}/pricing`,
        path: () => `${V1}/courses/${c}/pricing`,
        body: () => ({ amount: '29.99' }),
        expect: write,
        schema: CoursePricingSchema,
      },
      {
        method: 'get',
        template: `${V1}/courses/{courseId}/coupons`,
        path: () => `${V1}/courses/${c}/coupons`,
        expect: read,
        schema: CouponPageSchema,
      },
      {
        method: 'post',
        template: `${V1}/courses/{courseId}/coupons`,
        path: () => `${V1}/courses/${c}/coupons`,
        body: couponBody,
        expect: { ...write, owner: 201 },
        schema: CouponSchema,
      },
      {
        method: 'post',
        template: `${V1}/courses/{courseId}/coupons/{couponId}/deactivate`,
        path: () => `${V1}/courses/${c}/coupons/${couponId}/deactivate`,
        expect: write,
        schema: CouponSchema,
      },
      {
        method: 'get',
        template: `${V1}/admin/coupons`,
        path: () => `${V1}/admin/coupons`,
        expect: adminOnly,
        schema: CouponPageSchema,
      },
      {
        method: 'post',
        template: `${V1}/admin/coupons`,
        path: () => `${V1}/admin/coupons`,
        body: couponBody,
        expect: { ...adminOnly, admin: 201 },
        schema: CouponSchema,
      },
      {
        method: 'post',
        template: `${V1}/admin/coupons/{couponId}/deactivate`,
        path: () => `${V1}/admin/coupons/${platformCouponId}/deactivate`,
        expect: adminOnly,
        schema: CouponSchema,
      },
    ];
  };

  it('the matrix covers exactly the commerce A operations of SECTION_8', (ctx) => {
    e2e.skip(ctx);
    const covered = routes()
      .map((r) => `${r.method.toUpperCase()} ${r.template}`)
      .sort();
    const listed = SECTION_8_PHASE_4_COMMERCE_A.map(([p, m]) => `${m.toUpperCase()} ${p}`).sort();
    expect(covered).toEqual(listed);
  });

  it('auth matrix: every route x anonymous / student / owner / other instructor / admin', async (ctx) => {
    e2e.skip(ctx);
    for (const route of routes()) {
      // Denied actors first, so a state-changing success cannot change what they see.
      const order = [...ACTORS].sort(
        (a, b) => Number(route.expect[a] < 300) - Number(route.expect[b] < 300),
      );
      for (const actor of order) {
        const label = `${route.method.toUpperCase()} ${route.template} as ${actor}`;
        const req = call(actor, route.method, route.path());
        const res = await (route.body === undefined ? req : req.send(route.body()));
        const status = route.expect[actor];
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(status);
        if (status >= 400) {
          const code = { 401: 'unauthorized', 403: ErrorCode.Forbidden, 404: ErrorCode.NotFound }[
            status
          ];
          expectProblem(res, status, code);
        } else if (route.schema !== undefined) {
          expect(
            route.schema.safeParse(res.body).success,
            `${label}: ${JSON.stringify(res.body)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('public prices: no client credentials is 401; the response is cacheable', async (ctx) => {
    e2e.skip(ctx);
    const { course } = fixtures();
    expectProblem(
      await e2e.http().get(`${V1}/commerce/prices?courseIds=${course.courseId}`),
      401,
      'unauthorized',
    );
    const res = await call(
      'anonymous',
      'get',
      `${V1}/commerce/prices?courseIds=${course.courseId},${randomUUID()}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(PUBLIC_PRICES_CACHE_CONTROL);
    expect(PublicPricesResponseSchema.parse(res.body).items.map((i) => i.courseId)).toEqual([
      course.courseId,
    ]);
    expectProblem(
      await call('anonymous', 'get', `${V1}/commerce/prices`),
      400,
      ErrorCode.ValidationFailed,
    );
    expectProblem(await call('anonymous', 'get', `${V1}/commerce/prices?courseIds=nope`), 400);
    const tooMany = Array.from({ length: 49 }, () => randomUUID()).join(',');
    expectProblem(
      await call('anonymous', 'get', `${V1}/commerce/prices?courseIds=${tooMany}`),
      400,
    );
  });

  it('IDOR (§9): instructor B on A’s pricing and coupons, and A’s coupon id under B’s course, is 404', async (ctx) => {
    e2e.skip(ctx);
    const { course, otherCourse, couponId } = fixtures();
    const other = bearer('other');
    expectProblem(
      await other.get(`${V1}/courses/${course.courseId}/pricing`),
      404,
      ErrorCode.NotFound,
    );
    expectProblem(
      await other.post(`${V1}/courses/${otherCourse.courseId}/coupons/${couponId}/deactivate`),
      404,
      ErrorCode.NotFound,
    );
    // The owner's coupon is untouched by B's attempt (and by the admin platform route).
    expectProblem(await bearer('admin').post(`${V1}/admin/coupons/${couponId}/deactivate`), 404);
    expectProblem(await other.get(`${V1}/courses/not-a-uuid/pricing`), 404);
    // A student token replayed through the instructor BFF is not a session there.
    const replay = e2e
      .http()
      .get(`${V1}/me/cart`)
      .set(e2e.client('instructor'))
      .set('Authorization', `Bearer ${fixtures().tokens.student.accessToken}`);
    expectProblem(await replay, 401, 'unauthorized');
  });

  it('documented errors over HTTP: price_not_allowed, eligibility, coupon_invalid, validation', async (ctx) => {
    e2e.skip(ctx);
    const { course, cartCourse } = fixtures();
    const owner = bearer('owner');
    expectProblem(
      await owner.put(`${V1}/courses/${course.courseId}/pricing`).send({ amount: '13.37' }),
      422,
      ErrorCode.PriceNotAllowed,
    );
    expectProblem(
      await owner.put(`${V1}/courses/${course.courseId}/pricing`).send({ amount: 19.99 }),
      400,
    );

    const student = bearer('student');
    expectProblem(
      await student.put(`${V1}/me/cart/items/${randomUUID()}`),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(
      await student.put(`${V1}/me/cart/items/not-a-uuid`),
      400,
      ErrorCode.ValidationFailed,
    );
    const free = await newCourse(fixtures().users.owner.userId, '0.00');
    expectProblem(
      await student.put(`${V1}/me/cart/items/${free.courseId}`),
      409,
      ErrorCode.CourseIsFree,
    );
    // The owner buys through the student app like everyone else, but not their own course.
    const ownerAsStudent = e2e.as(
      'student',
      (await e2e.login('student', fixtures().users.owner.email)).accessToken,
    );
    expectProblem(
      await ownerAsStudent.put(`${V1}/me/cart/items/${cartCourse.courseId}`),
      409,
      ErrorCode.CannotPurchaseOwnCourse,
    );

    expectProblem(
      await student.put(`${V1}/me/cart/coupon`).send({ code: testCouponCode('NOPE') }),
      422,
      ErrorCode.CouponInvalid,
    );
    expectProblem(await student.put(`${V1}/me/cart/coupon`).send({ code: 'a!' }), 400);
    expectProblem(
      await student.post(`${V1}/me/cart/merge`).send({ courseIds: [] }),
      400,
      ErrorCode.ValidationFailed,
    );

    const withStart = await owner.post(`${V1}/courses/${course.courseId}/coupons`).send({
      ...couponBody(),
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 40 * DAY).toISOString(),
    });
    expectProblem(withStart, 400, ErrorCode.ValidationFailed); // the schema checks a given window
    const tooLong = await owner.post(`${V1}/courses/${course.courseId}/coupons`).send({
      code: testCouponCode('LONG'),
      discountType: 'PERCENT',
      percentOff: 10,
      endsAt: new Date(Date.now() + 40 * DAY).toISOString(),
    });
    expectProblem(tooLong, 422, ErrorCode.ValidationFailed); // no startsAt: the api checks it
  });

  it('a created coupon has a Location and appears in the list; the cart applies it', async (ctx) => {
    e2e.skip(ctx);
    const { cartCourse } = fixtures();
    const owner = bearer('owner');
    const body = { ...couponBody(), percentOff: 50 };
    const created = await owner.post(`${V1}/courses/${cartCourse.courseId}/coupons`).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const coupon = CouponSchema.parse(created.body);
    expect(created.headers.location).toBe(
      `${V1}/courses/${cartCourse.courseId}/coupons/${coupon.id}`,
    );
    const list = CouponPageSchema.parse(
      (await owner.get(`${V1}/courses/${cartCourse.courseId}/coupons?limit=100`)).body,
    );
    expect(list.items.map((x) => x.id)).toContain(coupon.id);
    expectProblem(
      await owner.post(`${V1}/courses/${cartCourse.courseId}/coupons`).send(body),
      409,
      ErrorCode.CouponCodeTaken,
    );

    const student = bearer('student');
    await student.put(`${V1}/me/cart/items/${cartCourse.courseId}`).expect(200);
    const quote = CartQuoteSchema.parse(
      (await student.put(`${V1}/me/cart/coupon`).send({ code: body.code })).body,
    );
    const line = quote.lines.find((l) => l.courseId === cartCourse.courseId);
    expect(line).toMatchObject({
      listAmount: '49.99',
      discountAmount: '25.00',
      finalAmount: '24.99',
      couponId: coupon.id,
    });
    expect(quote.coupon).toEqual({ code: body.code, applied: true, problem: null });
  });
});
