// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  type CartQuote,
  CartQuoteSchema,
  COMMERCE_COUPON_AGGREGATE,
  COMMERCE_COURSE_PRICE_AGGREGATE,
  CouponPageSchema,
  CouponSchema,
  CoursePricingSchema,
  ErrorCode,
  MergeGuestCartResponseSchema,
} from '@udemy/contracts';
import { sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS } from '../../setup-app';
import { RateLimitedError } from '../../shared/errors';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { CartQuoteService } from './application/cart-quote.service';
import { OrderOwnership } from './application/order.ownership';
import { TransactionRunner } from './application/ports/transaction-runner';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { ApplyCouponCommand } from './application/use-cases/apply-coupon.command';
import { CreateCourseCouponCommand } from './application/use-cases/create-course-coupon.command';
import { CreatePlatformCouponCommand } from './application/use-cases/create-platform-coupon.command';
import { DeactivateCouponCommand } from './application/use-cases/deactivate-coupon.command';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetCoursePricingQuery } from './application/use-cases/get-course-pricing.query';
import { GetPublicPricesQuery } from './application/use-cases/get-public-prices.query';
import { GetPurchaseStatesQuery } from './application/use-cases/get-purchase-states.query';
import { ListCouponsQuery } from './application/use-cases/list-coupons.query';
import { MergeGuestCartCommand } from './application/use-cases/merge-guest-cart.command';
import { RemoveCouponCommand } from './application/use-cases/remove-coupon.command';
import { RemoveFromCartCommand } from './application/use-cases/remove-from-cart.command';
import { SetCoursePriceCommand } from './application/use-cases/set-course-price.command';
import {
  AlreadyEnrolled,
  CannotPurchaseOwnCourse,
  CartFull,
  CommerceCourseNotFound,
  CouponCodeTaken,
  CouponLimitExceeded,
  CouponNotApplicable,
  CouponNotFound,
  CouponOnFreeCourse,
  CouponOnUnpricedCourse,
  CourseIsFree,
  CourseNotForSale,
  InvalidCommerceField,
  PriceNotAllowed,
} from './domain/commerce.errors';
import { CouponTerms } from './domain/coupon-terms';
import { Money } from './domain/money';
import { prng } from './domain/testing/prng';
import { commerceRateLimitKeys } from './infrastructure/redis-commerce-rate-limiter';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  insertCommerceTestUser,
  insertTestCoupon,
  insertTestCourse,
  insertTestEnrollment,
  insertTestRedemption,
  setTestCourseStatus,
  setTestPrice,
  type TestCourse,
  type TestCourseStatus,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T13 against the integration Postgres + Redis through the real AppModule (real catalog,
 * enrollment and identity facades, the `@udemy/db` quote SQL, triggers, the outbox and the
 * Redis rate limiters). Use cases are called directly; the HTTP auth matrix is in
 * commerce.e2e.spec.ts. Courses are written straight into the catalog tables (commerce only
 * needs a live revision), see testing/commerce-it.ts.
 */
const DAY = 86_400_000;
const NOW = (): number => Date.now();

describe('commerce A (integration: real AppModule, Postgres, Redis)', () => {
  const pg = useIntegrationDatabase({ max: 6 });
  const itRedis = useIntegrationRedis();
  const userIds: string[] = [];
  const courseIds: string[] = [];
  const ips: string[] = [];
  let app: NestExpressApplication | undefined;
  let owner = '';
  let otherOwner = '';
  let admin = '';

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean => pg.available && itRedis.available;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  async function user(label: string): Promise<string> {
    const id = await insertCommerceTestUser(pg.db, label);
    userIds.push(id);
    return id;
  }

  async function course(
    options: { ownerId?: string; status?: TestCourseStatus; price?: string | null } = {},
  ): Promise<TestCourse> {
    const ownerId = options.ownerId ?? owner;
    const created = await insertTestCourse(pg.db, { ownerId, status: options.status });
    courseIds.push(created.courseId);
    const price = options.price === undefined ? '49.99' : options.price;
    if (price !== null) await setTestPrice(pg.db, created.courseId, price, ownerId);
    return created;
  }

  function ip(): string {
    const value = `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 4)}`;
    ips.push(value);
    return value;
  }

  async function outboxOf(aggregateId: string, type: string) {
    return pg.db
      .selectFrom('outbox.events')
      .select(['aggregateType', 'type', 'payload'])
      .where('aggregateId', '=', aggregateId)
      .where('type', '=', type)
      .orderBy('createdAt')
      .execute();
  }

  const cart = (userId: string): Promise<CartQuote> => get(GetCartQuery).execute(userId);
  const add = (userId: string, courseId: string): Promise<CartQuote> =>
    get(AddToCartCommand).execute({ userId, courseId });
  const apply = (userId: string, code: string, at = ip()): Promise<CartQuote> =>
    get(ApplyCouponCommand).execute({ userId, ip: at, code });

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    await app.init();
    owner = await user('owner');
    otherOwner = await user('other-owner');
    admin = await user('admin');
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) {
        const keys = commerceRateLimitTestKeys({ userIds, courseIds, ips });
        if (keys.length > 0) await itRedis.redis.del(...keys);
        await deleteCommerceTestData(pg.db, { userIds, courseIds });
      }
    } finally {
      await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
      process.env = IT_APP_ENV.savedEnv;
    }
  });

  /* -------------------------------------------------------------------------------- pricing */

  describe('pricing (D2): tiers, history by trigger, CoursePriceChanged, 10 changes/day', () => {
    it('records every change, with previousAmount from RETURNING old, and no-ops unchanged prices', async (ctx) => {
      skip(ctx);
      const c = await course({ price: null });
      const pricing = await get(GetCoursePricingQuery).execute(c.courseId);
      expect(CoursePricingSchema.parse(pricing)).toEqual({
        courseId: c.courseId,
        price: null,
        isFree: false,
        history: [],
      });

      const set = (amount: string) =>
        get(SetCoursePriceCommand).execute({ actorId: owner, courseId: c.courseId, amount });
      const first = await set('19.99');
      expect(first.price).toEqual({ amount: '19.99', currency: 'USD' });
      expect(first.history).toMatchObject([
        { previousAmount: null, amount: '19.99', changedBy: owner },
      ]);
      const second = await set('24.99');
      expect(
        CoursePricingSchema.parse(second).history.map((h) => [h.previousAmount, h.amount]),
      ).toEqual([
        ['19.99', '24.99'],
        [null, '19.99'],
      ]);
      // Unchanged: no history row, no event, and the rate-limit bucket is not touched.
      const bucket = commerceRateLimitKeys.priceChange(c.courseId);
      expect(await itRedis.redis.get(bucket)).toBe('2');
      expect((await set('24.99')).history).toHaveLength(2);
      expect(await itRedis.redis.get(bucket)).toBe('2');

      const events = await outboxOf(c.courseId, 'CoursePriceChanged.v1');
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.aggregateType)).toEqual([
        COMMERCE_COURSE_PRICE_AGGREGATE,
        COMMERCE_COURSE_PRICE_AGGREGATE,
      ]);
      expect(events[1]?.payload).toMatchObject({
        courseId: c.courseId,
        previousAmount: '19.99',
        amount: '24.99',
        currency: 'USD',
        changedBy: owner,
      });

      const free = await set('0.00');
      expect(free).toMatchObject({ price: { amount: '0.00' }, isFree: true });
      await expect(set('13.37')).rejects.toBeInstanceOf(PriceNotAllowed);
      await expect(set('200.00')).rejects.toBeInstanceOf(PriceNotAllowed);
    });

    it('allows 10 changes per course per 24 h, then 429 with a retry window', async (ctx) => {
      skip(ctx);
      const c = await course({ price: null });
      const tiers = ['19.99', '24.99'];
      for (let i = 0; i < 10; i++) {
        await get(SetCoursePriceCommand).execute({
          actorId: owner,
          courseId: c.courseId,
          amount: tiers[i % 2] ?? '19.99',
        });
      }
      const limited = await get(SetCoursePriceCommand)
        .execute({ actorId: owner, courseId: c.courseId, amount: '29.99' })
        .catch((e: unknown) => e);
      expect(limited).toBeInstanceOf(RateLimitedError);
      expect((limited as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
      const pricing = await get(GetCoursePricingQuery).execute(c.courseId);
      expect(pricing.price?.amount).toBe('24.99');
      expect(pricing.history).toHaveLength(10);
      // Another course has its own bucket.
      const other = await course({ price: null });
      await get(SetCoursePriceCommand).execute({
        actorId: owner,
        courseId: other.courseId,
        amount: '29.99',
      });
    });

    it('lists the last 20 changes, computing previousAmount over the whole history', async (ctx) => {
      skip(ctx);
      const c = await course({ price: null });
      const amounts = Array.from({ length: 23 }, (_, i) => (i % 2 === 0 ? '19.99' : '99.99'));
      for (const amount of amounts) await setTestPrice(pg.db, c.courseId, amount, owner);
      const { history } = await get(GetCoursePricingQuery).execute(c.courseId);
      expect(history).toHaveLength(20);
      expect(history[0]?.amount).toBe(amounts.at(-1));
      // The oldest listed entry is change #4: its previous amount is change #3, not null.
      expect(history[19]?.previousAmount).toBe(amounts[2]);
      for (let i = 0; i < 19; i++) expect(history[i]?.previousAmount).toBe(history[i + 1]?.amount);
    });

    it('public prices: PUBLISHED + priced only, in request order', async (ctx) => {
      skip(ctx);
      const paid = await course({ price: '24.99' });
      const free = await course({ price: '0.00' });
      const unpriced = await course({ price: null });
      const archived = await course({ status: 'ARCHIVED' });
      const draft = await course({ status: 'DRAFT' });
      const { items } = await get(GetPublicPricesQuery).execute([
        free.courseId,
        unpriced.courseId,
        archived.courseId,
        draft.courseId,
        randomUUID(),
        paid.courseId,
      ]);
      expect(items).toEqual([
        { courseId: free.courseId, amount: '0.00', currency: 'USD', isFree: true },
        { courseId: paid.courseId, amount: '24.99', currency: 'USD', isFree: false },
      ]);
    });
  });

  /* --------------------------------------------------------------------------- cart (D4) */

  describe('cart eligibility matrix (design §4 order) and the quote', () => {
    it('adds only purchasable courses, each refusal with its §4 error', async (ctx) => {
      skip(ctx);
      const student = await user('student');
      const ok = await course({ price: '19.99' });
      const free = await course({ price: '0.00' });
      const unpriced = await course({ price: null });
      const archived = await course({ status: 'ARCHIVED' });
      const draft = await course({ status: 'DRAFT' });
      const own = await course({ ownerId: student });
      const enrolled = await course();
      await insertTestEnrollment(pg.db, student, enrolled.courseId);

      const quote = CartQuoteSchema.parse(await add(student, ok.courseId));
      expect(quote.lines.map((l) => l.courseId)).toEqual([ok.courseId]);
      expect(quote.lines[0]).toMatchObject({
        title: ok.title,
        slug: ok.slug,
        instructor: { id: owner, displayName: 'Commerce IT owner' },
        listAmount: '19.99',
        discountAmount: '0.00',
        finalAmount: '19.99',
        couponId: null,
      });
      // Adding twice is a no-op 200.
      expect((await add(student, ok.courseId)).itemCount).toBe(1);

      const refusal = (courseId: string) => add(student, courseId).catch((e: unknown) => e);
      expect(await refusal(free.courseId)).toBeInstanceOf(CourseIsFree);
      expect(await refusal(unpriced.courseId)).toBeInstanceOf(CourseNotForSale);
      expect(await refusal(archived.courseId)).toBeInstanceOf(CourseNotForSale);
      expect(await refusal(draft.courseId)).toBeInstanceOf(CommerceCourseNotFound);
      expect(await refusal(randomUUID())).toBeInstanceOf(CommerceCourseNotFound);
      expect(await refusal(own.courseId)).toBeInstanceOf(CannotPurchaseOwnCourse);
      expect(await refusal(enrolled.courseId)).toBeInstanceOf(AlreadyEnrolled);
      expect((await cart(student)).itemCount).toBe(1);

      const removed = await get(RemoveFromCartCommand).execute({
        userId: student,
        courseId: ok.courseId,
      });
      expect(removed.itemCount).toBe(0);
      await get(RemoveFromCartCommand).execute({ userId: student, courseId: ok.courseId });
    });

    it('reports lines that became unavailable (and live price changes) in the quote', async (ctx) => {
      skip(ctx);
      const student = await user('student-unavailable');
      const a = await course({ price: '19.99' });
      const b = await course({ price: '24.99' });
      const c = await course({ price: '29.99' });
      const d = await course({ price: '34.99' });
      for (const x of [a, b, c, d]) await add(student, x.courseId);
      await setTestCourseStatus(pg.db, b.courseId, 'ARCHIVED');
      await setTestPrice(pg.db, c.courseId, '0.00', owner);
      await insertTestEnrollment(pg.db, student, d.courseId);
      await setTestPrice(pg.db, a.courseId, '39.99', owner);

      const quote = CartQuoteSchema.parse(await cart(student));
      expect(quote.lines.map((l) => [l.courseId, l.listAmount])).toEqual([[a.courseId, '39.99']]);
      expect(quote.unavailable.map((u) => [u.courseId, u.reason, u.title])).toEqual([
        [b.courseId, ErrorCode.CourseNotForSale, b.title],
        [c.courseId, ErrorCode.CourseIsFree, c.title],
        [d.courseId, ErrorCode.AlreadyEnrolled, d.title],
      ]);
      expect(quote.itemCount).toBe(4);
      expect(quote.totals).toEqual({
        listAmount: '39.99',
        discountAmount: '0.00',
        totalAmount: '39.99',
      });
    });

    it('holds at most 20 items (422 cart_full), counted under the cart lock', async (ctx) => {
      skip(ctx);
      const student = await user('student-full');
      const many = await Promise.all(Array.from({ length: 21 }, () => course({ price: '19.99' })));
      // 20 concurrent adds on one cart serialise on the cart row: exactly 20 fit.
      await Promise.all(many.slice(0, 20).map((c) => add(student, c.courseId)));
      expect((await cart(student)).itemCount).toBe(20);
      const last = many[20];
      if (last === undefined) throw new Error('fixture');
      await expect(add(student, last.courseId)).rejects.toBeInstanceOf(CartFull);
      // Re-adding an existing item is still fine when full.
      expect((await add(student, many[0]?.courseId ?? '')).itemCount).toBe(20);
    });

    it('merges the guest cart best effort and reports every skip with its reason', async (ctx) => {
      skip(ctx);
      const student = await user('student-merge');
      const inCart = await course({ price: '19.99' });
      const fresh = await course({ price: '24.99' });
      const free = await course({ price: '0.00' });
      const unpriced = await course({ price: null });
      const archived = await course({ status: 'ARCHIVED' });
      const own = await course({ ownerId: student });
      const enrolled = await course();
      await insertTestEnrollment(pg.db, student, enrolled.courseId);
      const unknown = randomUUID();
      await add(student, inCart.courseId);

      const merged = MergeGuestCartResponseSchema.parse(
        await get(MergeGuestCartCommand).execute({
          userId: student,
          courseIds: [
            inCart.courseId,
            fresh.courseId,
            free.courseId,
            unpriced.courseId,
            archived.courseId,
            own.courseId,
            enrolled.courseId,
            unknown,
          ],
        }),
      );
      expect(merged.added).toEqual([fresh.courseId]);
      expect(merged.skipped).toEqual([
        { courseId: free.courseId, reason: ErrorCode.CourseIsFree },
        { courseId: unpriced.courseId, reason: ErrorCode.CourseNotForSale },
        { courseId: archived.courseId, reason: ErrorCode.CourseNotForSale },
        { courseId: own.courseId, reason: ErrorCode.CannotPurchaseOwnCourse },
        { courseId: enrolled.courseId, reason: ErrorCode.AlreadyEnrolled },
        { courseId: unknown, reason: ErrorCode.CourseNotFound },
      ]);
      expect(merged.quote.lines.map((l) => l.courseId)).toEqual([inCart.courseId, fresh.courseId]);
    });

    it('merge skips with cart_full once the cart has no room left', async (ctx) => {
      skip(ctx);
      const student = await user('student-merge-full');
      const many = await Promise.all(Array.from({ length: 21 }, () => course({ price: '19.99' })));
      for (const c of many.slice(0, 18)) await add(student, c.courseId);
      const rest = many.slice(18).map((c) => c.courseId);
      const merged = await get(MergeGuestCartCommand).execute({ userId: student, courseIds: rest });
      expect(merged.added).toEqual(rest.slice(0, 2));
      expect(merged.skipped).toEqual([{ courseId: rest[2], reason: ErrorCode.CartFull }]);
      expect(merged.quote.itemCount).toBe(20);
    });
  });

  /* ------------------------------------------------------------------------- coupons (D5) */

  describe('best-of coupon selection per line (course vs platform, tie -> course)', () => {
    it('picks the larger discount per line and agrees with the domain best-of', async (ctx) => {
      skip(ctx);
      const student = await user('student-best');
      const cheap = await course({ price: '19.99' });
      const pricey = await course({ price: '49.99' });
      const code = testCouponCode('BEST');
      const courseCoupon = await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: pricey.courseId,
        code,
        percentOff: 40,
      });
      const platformCoupon = await insertTestCoupon(pg.db, {
        createdBy: admin,
        code,
        percentOff: 30,
      });
      await add(student, cheap.courseId);
      await add(student, pricey.courseId);

      const quote = CartQuoteSchema.parse(await apply(student, code.toLowerCase().toUpperCase()));
      // 19.99: only the platform coupon applies: 30% = 5.997 -> 6.00 (half up).
      // 49.99: course 40% = 19.996 -> 20.00 beats platform 30% = 15.00.
      expect(
        quote.lines.map((l) => [l.listAmount, l.discountAmount, l.finalAmount, l.couponId]),
      ).toEqual([
        ['19.99', '6.00', '13.99', platformCoupon],
        ['49.99', '20.00', '29.99', courseCoupon],
      ]);
      expect(quote.totals).toEqual({
        listAmount: '69.98',
        discountAmount: '26.00',
        totalAmount: '43.98',
      });
      expect(quote.coupon).toEqual({ code, applied: true, problem: null });

      const priced = await get(TransactionRunner).run((trx) =>
        get(CartQuoteService).price(student, trx),
      );
      expect(priced.quote.divergences).toEqual([]);
      expect(priced.view.fingerprint).toBe(quote.fingerprint);
    });

    it('gives a tie to the course coupon, even with a lower id on the platform coupon', async (ctx) => {
      skip(ctx);
      const student = await user('student-tie');
      const c = await course({ price: '49.99' });
      const code = testCouponCode('TIE');
      // Platform first, so its uuidv7 id sorts lower: only the scope rule can pick the course one.
      const platformCoupon = await insertTestCoupon(pg.db, {
        createdBy: admin,
        code,
        percentOff: 30,
      });
      const courseCoupon = await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code,
        amountOff: '15.00', // = 30% of 49.99 rounded half up
      });
      expect(platformCoupon < courseCoupon).toBe(true);
      await add(student, c.courseId);
      const quote = await apply(student, code);
      expect(quote.lines[0]).toMatchObject({ discountAmount: '15.00', couponId: courseCoupon });
    });

    it('SQL commerce.coupon_discount equals CouponTerms.discountFor (seeded sample)', async (ctx) => {
      skip(ctx);
      const r = prng(31337);
      const cases = Array.from({ length: 400 }, () => {
        const list = Money.ofMinor(r.int(0, 999_999), 'USD');
        return r.bool()
          ? { list, type: 'PERCENT' as const, percentOff: r.int(1, 100), amountOff: null }
          : {
              list,
              type: 'AMOUNT' as const,
              percentOff: null,
              amountOff: Money.ofMinor(r.int(1, 1_200_000), 'USD'),
            };
      });
      const { rows } = await sql<{ d: string }>`
        SELECT commerce.coupon_discount(x.list, x.type, x.pct, x.amt)::numeric(12,2)::text AS d
          FROM unnest(${cases.map((c) => c.list.toDecimal())}::numeric[],
                      ${cases.map((c) => c.type)}::text[],
                      ${cases.map((c) => c.percentOff)}::smallint[],
                      ${cases.map((c) => c.amountOff?.toDecimal() ?? null)}::numeric[])
               WITH ORDINALITY AS x(list, type, pct, amt, n)
         ORDER BY x.n
      `.execute(pg.db);
      cases.forEach((c, i) => {
        const terms = CouponTerms.of({
          id: randomUUID(),
          scope: c.type === 'PERCENT' ? 'PLATFORM' : 'COURSE',
          courseId: c.type === 'PERCENT' ? null : randomUUID(),
          discount:
            c.type === 'PERCENT'
              ? { type: 'PERCENT', percentOff: c.percentOff ?? 1 }
              : { type: 'AMOUNT', amountOff: c.amountOff ?? Money.zero('USD') },
        });
        expect(terms.discountFor(c.list)?.toDecimal(), JSON.stringify(c)).toBe(rows[i]?.d);
      });
    });
  });

  describe('coupon apply: validity, limits, generic vs specific errors, rate limit', () => {
    it('reveals specific problems only for codes that match the cart', async (ctx) => {
      skip(ctx);
      const student = await user('student-codes');
      const other = await user('student-other');
      const c = await course({ price: '24.99' });
      const elsewhere = await course({ price: '24.99' });
      await add(student, c.courseId);
      const codes = {
        unknown: testCouponCode('NONE'),
        foreign: testCouponCode('FOREIGN'),
        expired: testCouponCode('EXP'),
        scheduled: testCouponCode('SOON'),
        exhausted: testCouponCode('GONE'),
        used: testCouponCode('USED'),
        deactivated: testCouponCode('OFF'),
      };
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: elsewhere.courseId,
        code: codes.foreign,
      });
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: codes.expired,
        startsAt: new Date(NOW() - 10 * DAY),
        endsAt: new Date(NOW() - DAY),
      });
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: codes.scheduled,
        startsAt: new Date(NOW() + DAY),
        endsAt: new Date(NOW() + 3 * DAY),
      });
      const exhausted = await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: codes.exhausted,
        maxRedemptions: 1,
      });
      await insertTestRedemption(pg.db, { couponId: exhausted, userId: other, status: 'CONSUMED' });
      const used = await insertTestCoupon(pg.db, {
        createdBy: admin,
        code: codes.used,
        percentOff: 10,
      });
      await insertTestRedemption(pg.db, { couponId: used, userId: student, status: 'RESERVED' });
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: codes.deactivated,
        deactivated: true,
      });

      const problem = async (code: string) => {
        const error = await apply(student, code).catch((e: unknown) => e);
        expect(error, code).toBeInstanceOf(CouponNotApplicable);
        return (error as CouponNotApplicable).problem;
      };
      expect(await problem(codes.unknown)).toBe(ErrorCode.CouponInvalid);
      expect(await problem(codes.foreign)).toBe(ErrorCode.CouponInvalid);
      expect(await problem(codes.deactivated)).toBe(ErrorCode.CouponInvalid);
      expect(await problem(codes.expired)).toBe(ErrorCode.CouponExpired);
      expect(await problem(codes.scheduled)).toBe(ErrorCode.CouponNotStarted);
      expect(await problem(codes.exhausted)).toBe(ErrorCode.CouponExhausted);
      expect(await problem(codes.used)).toBe(ErrorCode.CouponAlreadyUsed);
      // None of the failures stored a code.
      expect((await cart(student)).coupon).toBeNull();
    });

    it('keeps the previous code on a failed apply, reports a code that stopped applying, and removes it', async (ctx) => {
      skip(ctx);
      const student = await user('student-keep');
      const c = await course({ price: '24.99' });
      await add(student, c.courseId);
      const good = testCouponCode('GOOD');
      const couponId = await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: good,
        percentOff: 20,
      });
      expect((await apply(student, good)).totals.totalAmount).toBe('19.99');
      await expect(apply(student, testCouponCode('BAD'))).rejects.toBeInstanceOf(
        CouponNotApplicable,
      );
      expect((await cart(student)).coupon).toEqual({ code: good, applied: true, problem: null });

      await get(DeactivateCouponCommand).execute({
        actorId: owner,
        couponId,
        filter: { scope: 'COURSE', courseId: c.courseId },
      });
      const reported = await cart(student);
      expect(reported.coupon).toEqual({
        code: good,
        applied: false,
        problem: ErrorCode.CouponInvalid,
      });
      expect(reported.totals.totalAmount).toBe('24.99');

      const cleared = await get(RemoveCouponCommand).execute(student);
      expect(cleared.coupon).toBeNull();
    });

    it('counts every apply: 20 per user per hour, then 429 (also for valid codes)', async (ctx) => {
      skip(ctx);
      const student = await user('student-brute');
      const c = await course({ price: '24.99' });
      await add(student, c.courseId);
      const good = testCouponCode('OK');
      await insertTestCoupon(pg.db, { createdBy: owner, courseId: c.courseId, code: good });
      for (let i = 0; i < 19; i++) {
        await expect(apply(student, testCouponCode('X'))).rejects.toBeInstanceOf(
          CouponNotApplicable,
        );
      }
      await apply(student, good); // the 20th attempt is still allowed
      const limited = await apply(student, good).catch((e: unknown) => e);
      expect(limited).toBeInstanceOf(RateLimitedError);
      expect(Number(await itRedis.redis.get(commerceRateLimitKeys.couponApplyUser(student)))).toBe(
        21,
      );
    });

    it('limits one IP to 60 applies per hour across accounts', async (ctx) => {
      skip(ctx);
      const shared = ip();
      await itRedis.redis.set(commerceRateLimitKeys.couponApplyIp(shared), '60', 'PX', 3_600_000);
      const student = await user('student-ip');
      const error = await apply(student, testCouponCode('IP'), shared).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitedError);
    });
  });

  describe('coupon management (instructor course coupons, admin platform coupons)', () => {
    const percent = (code: string, days = 7) => ({
      code,
      discountType: 'PERCENT' as const,
      percentOff: 25,
      endsAt: new Date(NOW() + days * DAY).toISOString(),
    });
    const create = (
      courseId: string,
      request: Parameters<CreateCourseCouponCommand['execute']>[0]['request'],
    ) => get(CreateCourseCouponCommand).execute({ actorId: owner, courseId, request });

    it('creates a course coupon with its event; validates price, terms, window and code', async (ctx) => {
      skip(ctx);
      const c = await course({ price: '24.99' });
      const code = testCouponCode('NEW');
      const coupon = CouponSchema.parse(
        await create(c.courseId, { ...percent(code), maxRedemptions: 5 }),
      );
      expect(coupon).toMatchObject({
        scope: 'COURSE',
        courseId: c.courseId,
        code,
        discountType: 'PERCENT',
        percentOff: 25,
        amountOff: null,
        maxRedemptions: 5,
        state: 'ACTIVE',
        redemptions: { reserved: 0, consumed: 0 },
        createdBy: owner,
        deactivatedAt: null,
      });
      const [event] = await outboxOf(coupon.id, 'CouponCreated.v1');
      expect(event?.aggregateType).toBe(COMMERCE_COUPON_AGGREGATE);
      expect(event?.payload).toMatchObject({
        couponId: coupon.id,
        scope: 'COURSE',
        code,
        percentOff: 25,
        actorId: owner,
      });

      const scheduled = await create(c.courseId, {
        ...percent(testCouponCode('LATER')),
        startsAt: new Date(NOW() + 2 * DAY).toISOString(),
        endsAt: new Date(NOW() + 5 * DAY).toISOString(),
      });
      expect(scheduled.state).toBe('SCHEDULED');
      const amount = await create(c.courseId, {
        code: testCouponCode('AMT'),
        discountType: 'AMOUNT',
        amountOff: '24.99',
        endsAt: new Date(NOW() + 2 * DAY).toISOString(),
      });
      expect(amount).toMatchObject({
        discountType: 'AMOUNT',
        amountOff: '24.99',
        currency: 'USD',
        percentOff: null,
      });

      const issue = async (request: Parameters<typeof create>[1]) => {
        const error = await create(c.courseId, request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InvalidCommerceField);
        return (error as InvalidCommerceField).issues.map((i) => i.path);
      };
      expect(
        await issue({
          code: testCouponCode('BIG'),
          discountType: 'AMOUNT',
          amountOff: '25.00',
          endsAt: percent('X').endsAt,
        }),
      ).toEqual(['amountOff']);
      expect(await issue(percent(testCouponCode('LONG'), 32))).toEqual(['endsAt']);
      expect(await issue(percent(testCouponCode('SHORT'), 0.5))).toEqual(['endsAt']);
      expect(
        await issue({
          ...percent(testCouponCode('FAR')),
          startsAt: new Date(NOW() + 91 * DAY).toISOString(),
          endsAt: new Date(NOW() + 92 * DAY).toISOString(),
        }),
      ).toEqual(['startsAt']);

      // Codes are unique per course (also after deactivation); other scopes may reuse them.
      await expect(create(c.courseId, percent(code))).rejects.toBeInstanceOf(CouponCodeTaken);
      const other = await course({ price: '24.99' });
      await create(other.courseId, percent(code));
      await get(CreatePlatformCouponCommand).execute({
        actorId: admin,
        request: { ...percent(code), discountType: 'PERCENT' },
      });

      await expect(
        create((await course({ price: null })).courseId, percent(testCouponCode('U'))),
      ).rejects.toBeInstanceOf(CouponOnUnpricedCourse);
      await expect(
        create((await course({ price: '0.00' })).courseId, percent(testCouponCode('F'))),
      ).rejects.toBeInstanceOf(CouponOnFreeCourse);
    });

    it('allows at most 10 active coupons per course; expired and deactivated ones do not count', async (ctx) => {
      skip(ctx);
      const c = await course({ price: '24.99' });
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: testCouponCode('OLD'),
        startsAt: new Date(NOW() - 10 * DAY),
        endsAt: new Date(NOW() - DAY),
      });
      await insertTestCoupon(pg.db, {
        createdBy: owner,
        courseId: c.courseId,
        code: testCouponCode('DEAD'),
        deactivated: true,
      });
      const ids: string[] = [];
      for (let i = 0; i < 10; i++)
        ids.push((await create(c.courseId, percent(testCouponCode(`L${i}`)))).id);
      await expect(create(c.courseId, percent(testCouponCode('L10')))).rejects.toBeInstanceOf(
        CouponLimitExceeded,
      );
      await get(DeactivateCouponCommand).execute({
        actorId: owner,
        couponId: ids[0] ?? '',
        filter: { scope: 'COURSE', courseId: c.courseId },
      });
      await create(c.courseId, percent(testCouponCode('L11')));
    });

    it('deactivates idempotently (one event), scoped to the course; lists newest first with states and counts', async (ctx) => {
      skip(ctx);
      const c = await course({ price: '24.99' });
      const foreign = await course({ ownerId: otherOwner, price: '24.99' });
      const a = await create(c.courseId, { ...percent(testCouponCode('A')), maxRedemptions: 2 });
      const b = await create(c.courseId, percent(testCouponCode('B')));
      const buyer1 = await user('buyer1');
      const buyer2 = await user('buyer2');
      await insertTestRedemption(pg.db, { couponId: a.id, userId: buyer1, status: 'RESERVED' });
      await insertTestRedemption(pg.db, { couponId: a.id, userId: buyer2, status: 'CONSUMED' });

      const deactivate = (couponId: string, courseId: string) =>
        get(DeactivateCouponCommand).execute({
          actorId: owner,
          couponId,
          filter: { scope: 'COURSE', courseId },
        });
      const first = await deactivate(b.id, c.courseId);
      const again = await deactivate(b.id, c.courseId);
      expect(first.state).toBe('DEACTIVATED');
      expect(again.deactivatedAt).toBe(first.deactivatedAt);
      expect(await outboxOf(b.id, 'CouponDeactivated.v1')).toHaveLength(1);
      await expect(deactivate(b.id, foreign.courseId)).rejects.toBeInstanceOf(CouponNotFound);
      await expect(
        get(DeactivateCouponCommand).execute({
          actorId: admin,
          couponId: a.id,
          filter: { scope: 'PLATFORM' },
        }),
      ).rejects.toBeInstanceOf(CouponNotFound);

      const list = (cursor?: string) =>
        get(ListCouponsQuery).execute({
          filter: { scope: 'COURSE', courseId: c.courseId },
          cursor,
          limit: 1,
        });
      const page1 = CouponPageSchema.parse(await list());
      expect(page1.items.map((x) => [x.id, x.state])).toEqual([[b.id, 'DEACTIVATED']]);
      const page2 = CouponPageSchema.parse(await list(page1.nextCursor ?? undefined));
      expect(page2.items.map((x) => [x.id, x.state, x.redemptions])).toEqual([
        [a.id, 'EXHAUSTED', { reserved: 1, consumed: 1 }],
      ]);
      expect(page2.nextCursor).toBeNull();
      const foreignList = await get(ListCouponsQuery).execute({
        filter: { scope: 'COURSE', courseId: foreign.courseId },
        limit: 10,
      });
      expect(foreignList.items).toEqual([]);
    });

    it('platform coupons: PERCENT, up to 90 days, listed apart from course coupons', async (ctx) => {
      skip(ctx);
      const code = testCouponCode('PLAT');
      const created = await get(CreatePlatformCouponCommand).execute({
        actorId: admin,
        // Just below the 90-day bound: the window is measured on the DB clock, not this one.
        request: { ...percent(code, 89.9), discountType: 'PERCENT' },
      });
      expect(created).toMatchObject({ scope: 'PLATFORM', courseId: null, code, state: 'ACTIVE' });
      await expect(
        get(CreatePlatformCouponCommand).execute({
          actorId: admin,
          request: { ...percent(testCouponCode('P91'), 91), discountType: 'PERCENT' },
        }),
      ).rejects.toBeInstanceOf(InvalidCommerceField);
      await expect(
        get(CreatePlatformCouponCommand).execute({
          actorId: admin,
          request: { ...percent(code), discountType: 'PERCENT' },
        }),
      ).rejects.toBeInstanceOf(CouponCodeTaken);
      const page = await get(ListCouponsQuery).execute({
        filter: { scope: 'PLATFORM' },
        limit: 100,
      });
      expect(page.items.every((x) => x.scope === 'PLATFORM')).toBe(true);
      expect(page.items.map((x) => x.id)).toContain(created.id);
    });
  });

  /* ----------------------------------------------------------- purchase states, ownership */

  it('purchase states compose enrollment, cart and owner per requested id', async (ctx) => {
    skip(ctx);
    const student = await user('student-states');
    const own = await course({ ownerId: student });
    const carted = await course();
    const enrolled = await course({ status: 'ARCHIVED' });
    await add(student, carted.courseId);
    await insertTestEnrollment(pg.db, student, enrolled.courseId);
    const unknown = randomUUID();
    const { items } = await get(GetPurchaseStatesQuery).execute({
      userId: student,
      courseIds: [own.courseId, carted.courseId, enrolled.courseId, unknown],
    });
    expect(items).toEqual([
      { courseId: own.courseId, enrolled: false, inCart: false, isOwner: true },
      { courseId: carted.courseId, enrolled: false, inCart: true, isOwner: false },
      { courseId: enrolled.courseId, enrolled: true, inCart: false, isOwner: false },
      { courseId: unknown, enrolled: false, inCart: false, isOwner: false },
    ]);
  });

  it('OrderOwnership resolves the buyer; unknown and malformed ids are null (404)', async (ctx) => {
    skip(ctx);
    const buyer = await user('order-owner');
    const couponId = await insertTestCoupon(pg.db, {
      createdBy: admin,
      code: testCouponCode('ORD'),
    });
    const orderId = await insertTestRedemption(pg.db, {
      couponId,
      userId: buyer,
      status: 'CONSUMED',
    });
    const ownership = get(OrderOwnership);
    expect(await ownership.ownerOf(orderId)).toBe(buyer);
    expect(await ownership.ownerOf(randomUUID())).toBeNull();
    expect(await ownership.ownerOf('not-a-uuid')).toBeNull();
  });
});
