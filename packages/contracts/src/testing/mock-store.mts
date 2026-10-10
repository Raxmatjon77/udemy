import { ErrorCode } from '../errors/error-code.js';
import type { PersonRef } from '../http/catalog.js';
import type {
  AdminBuyer,
  AdminOrderDetail,
  AdminOrderRow,
  AdminOrderTimelineEntry,
  AdminRefund,
  AdminRefundQueueItem,
  OrderTransition,
  RefundTransition,
} from '../http/commerce-admin.js';
import type {
  CartLine,
  CartQuote,
  CartUnavailableLine,
  MergeSkipReason,
  PurchaseState,
} from '../http/commerce-cart.js';
import type {
  CouponProblemCode,
  CouponState,
  OrderStatus,
  OrderTransitionCause,
  PaymentStatus,
  PurchaseBlockReason,
  RefundBlockReason,
  RefundInitiator,
  RefundReasonCode,
  RefundStatus,
} from '../http/commerce-common.js';
import { REFUND_REVIEW_LOOKBACK_DAYS, REFUND_REVIEW_THRESHOLD } from '../http/commerce-common.js';
import type { Coupon } from '../http/commerce-coupons.js';
import type { OrderDetail, OrderSummary, Receipt, Refund } from '../http/commerce-orders.js';
import type { CoursePriceChange, CoursePricing, PublicPrice } from '../http/commerce-pricing.js';
import type { RecentSale, SalesSummary, SalesTotals } from '../http/commerce-sales.js';
import type {
  AdminEnrollment,
  Enrollment,
  EnrollmentRevokeReason,
  EnrollmentSource,
  EnrollmentTransition,
  LearningCard,
} from '../http/enrollment.js';
import { MIN_CHARGE_MINOR, moneyToMinor, sumMoney, subtractMoneyFloored } from '../money/money.js';
import { isFreeAmount, isPriceTier } from '../money/price-tiers.js';
import { discountFor } from '../money/money.js';
import {
  DEFAULT_REVENUE_SHARE_BPS,
  FIXTURE_IDS,
  fixtureFingerprint,
  fixtureId,
  instructorShareOf,
} from './fixtures.mjs';

/**
 * An in-memory model of the Phase 4 commerce & enrollment api, behind the MSW handlers
 * (`createCommerceHandlers`). It follows the design's rules closely enough for UI work:
 * purchase eligibility (§4), best-coupon-per-line (D5), checkout errors in the §5 order, the
 * zero-total path (D14), one open order per user (D15), refund eligibility (D11).
 *
 * One **viewer** makes every request (the signed-in user of the app under test), acting as
 * student, instructor (for courses whose `ownerId` is the viewer) and admin. Every response
 * the handlers send is parsed with its contracts schema first.
 *
 * Not modelled: rate limits (429), pagination (every page has `nextCursor: null`), the
 * webhook (call `completePayment` / `expirePayment` / `settleRefund` instead).
 */

export interface MockUser {
  id: string;
  displayName: string;
  email: string;
  banned?: boolean;
}

export interface MockCourse {
  id: string;
  slug: string;
  title: string;
  ownerId: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'ARCHIVED';
  /** Null: no price row, not for sale (D16). */
  price: string | null;
  hasThumbnail?: boolean;
}

interface MockLine {
  id: string;
  lineNo: number;
  courseId: string;
  courseTitle: string;
  instructorId: string;
  listAmount: string;
  discountAmount: string;
  finalAmount: string;
  couponId: string | null;
  couponCode: string | null;
  revenueShareBps: number;
}

interface MockOrder {
  id: string;
  orderNumber: number;
  userId: string;
  status: OrderStatus;
  idempotencyKey: string | null;
  fingerprint: string;
  placedAt: string;
  paidAt: string | null;
  closedAt: string | null;
  lines: MockLine[];
  paymentStatus: PaymentStatus | null;
  sessionId: string | null;
  checkoutUrl: string | null;
  couponId: string | null;
  transitions: OrderTransition[];
}

interface MockRefund extends AdminRefund {
  rejectionReason: string | null;
  transitions: RefundTransition[];
}

interface MockEnrollment extends Enrollment {
  transitions: EnrollmentTransition[];
}

export interface CommerceMockSeed {
  /** The signed-in user. Default `FIXTURE_IDS.student`. */
  viewerId?: string;
  /** Paid checkout needs a verified email (D17). Default true. */
  emailVerified?: boolean;
  users?: MockUser[];
  /** Default: two paid courses and a free one, owned by `FIXTURE_IDS.instructor`. */
  courses?: MockCourse[];
  coupons?: Coupon[];
  /** Course ids already in the viewer's cart. */
  cart?: string[];
  /** `http://127.0.0.1:12111` (the emulator) by default. */
  checkoutOrigin?: string;
  /** Clock; default `() => new Date()`. */
  now?: () => Date;
  refundWindowDays?: number;
}

export class MockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultMockUsers(): MockUser[] {
  return [
    { id: FIXTURE_IDS.student, displayName: 'Jane Student', email: 'jane@example.com' },
    { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor', email: 'ada@example.com' },
    { id: FIXTURE_IDS.admin, displayName: 'Root Admin', email: 'admin@example.com' },
  ];
}

export function defaultMockCourses(): MockCourse[] {
  return [
    {
      id: FIXTURE_IDS.course,
      slug: 'complete-typescript',
      title: 'Complete TypeScript',
      ownerId: FIXTURE_IDS.instructor,
      status: 'PUBLISHED',
      price: '19.99',
      hasThumbnail: true,
    },
    {
      id: FIXTURE_IDS.course2,
      slug: 'postgres-in-depth',
      title: 'PostgreSQL in Depth',
      ownerId: FIXTURE_IDS.instructor,
      status: 'PUBLISHED',
      price: '49.99',
      hasThumbnail: false,
    },
    {
      id: FIXTURE_IDS.freeCourse,
      slug: 'git-basics',
      title: 'Git Basics',
      ownerId: FIXTURE_IDS.instructor,
      status: 'PUBLISHED',
      price: '0.00',
      hasThumbnail: false,
    },
  ];
}

export class CommerceMockStore {
  viewerId: string;
  emailVerified: boolean;
  checkoutOrigin: string;
  refundWindowDays: number;
  readonly users = new Map<string, MockUser>();
  readonly courses = new Map<string, MockCourse>();
  readonly coupons: Coupon[] = [];
  readonly priceHistory = new Map<string, CoursePriceChange[]>();
  private cartItems: { courseId: string; addedAt: string }[] = [];
  private cartCouponCode: string | null = null;
  private readonly orders: MockOrder[] = [];
  private readonly refunds: MockRefund[] = [];
  private readonly enrollments: MockEnrollment[] = [];
  /** `couponId:userId` → the order holding the RESERVED or CONSUMED redemption. */
  private readonly redeemed = new Map<string, string>();
  private readonly now: () => Date;
  private seq = 0x100;
  private orderNumber = 1000;

  constructor(seed: CommerceMockSeed = {}) {
    this.viewerId = seed.viewerId ?? FIXTURE_IDS.student;
    this.emailVerified = seed.emailVerified ?? true;
    this.checkoutOrigin = seed.checkoutOrigin ?? 'http://127.0.0.1:12111';
    this.refundWindowDays = seed.refundWindowDays ?? 30;
    this.now = seed.now ?? (() => new Date());
    for (const user of seed.users ?? defaultMockUsers()) this.users.set(user.id, user);
    for (const course of seed.courses ?? defaultMockCourses()) this.courses.set(course.id, course);
    this.coupons.push(...(seed.coupons ?? []));
    const at = this.iso();
    this.cartItems = (seed.cart ?? []).map((courseId) => ({ courseId, addedAt: at }));
  }

  /* ---------------------------------------------------------------- helpers */

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  private nextId(): string {
    this.seq += 1;
    return fixtureId(this.seq);
  }

  private person(userId: string): PersonRef | null {
    const user = this.users.get(userId);
    return user && !user.banned ? { id: user.id, displayName: user.displayName } : null;
  }

  /** Admin views show actors even when banned (design §9 audit). */
  private actor(userId: string | null): PersonRef | null {
    const user = userId === null ? undefined : this.users.get(userId);
    return user ? { id: user.id, displayName: user.displayName } : null;
  }

  private refundTransition(
    refund: MockRefund,
    toStatus: RefundStatus,
    extra: { actorId?: string | null; reason?: string | null; failureCode?: string | null } = {},
  ): void {
    const head = refund.transitions.at(-1);
    const actorId = extra.actorId ?? null;
    refund.transitions.push({
      seq: refund.transitions.length + 1,
      fromStatus: head?.toStatus ?? null,
      toStatus,
      actorId,
      actor: this.actor(actorId),
      reason: extra.reason ?? null,
      providerRefundId:
        toStatus === 'SUBMITTED' || toStatus === 'SUCCEEDED' ? refund.providerRefundId : null,
      failureCode: extra.failureCode ?? null,
      providerEventId: null,
      occurredAt: this.iso(),
    });
    refund.status = toStatus;
  }

  private buyer(userId: string): AdminBuyer | null {
    const user = this.users.get(userId);
    return user
      ? {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          status: user.banned ? 'BANNED' : 'ACTIVE',
        }
      : null;
  }

  private activeEnrollment(userId: string, courseId: string): MockEnrollment | undefined {
    return this.enrollments.find(
      (e) => e.userId === userId && e.courseId === courseId && e.status === 'ACTIVE',
    );
  }

  private ownCourse(courseId: string): MockCourse {
    const course = this.courses.get(courseId);
    if (!course || course.ownerId !== this.viewerId) {
      throw new MockApiError(404, ErrorCode.CourseNotFound);
    }
    return course;
  }

  private order(orderId: string, own: boolean): MockOrder {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order || (own && order.userId !== this.viewerId)) {
      throw new MockApiError(404, ErrorCode.OrderNotFound);
    }
    return order;
  }

  private transition(
    order: MockOrder,
    toStatus: OrderStatus,
    cause: OrderTransitionCause,
    extra: { actorId?: string | null; reason?: string | null; providerEventId?: string } = {},
  ): void {
    order.transitions.push({
      id: this.nextId(),
      fromStatus: order.transitions.length === 0 ? null : order.status,
      toStatus,
      cause,
      providerEventId: extra.providerEventId ?? null,
      actorId: extra.actorId ?? null,
      actor: this.actor(extra.actorId ?? null),
      reason: extra.reason ?? null,
      occurredAt: this.iso(),
    });
    order.status = toStatus;
  }

  /** §4 purchase eligibility, in order. */
  purchaseBlock(courseId: string, userId = this.viewerId): PurchaseBlockReason | null {
    const course = this.courses.get(courseId);
    if (!course) return ErrorCode.CourseNotFound;
    if (course.status !== 'PUBLISHED' || course.price === null) return ErrorCode.CourseNotForSale;
    if (isFreeAmount(course.price)) return ErrorCode.CourseIsFree;
    if (course.ownerId === userId) return ErrorCode.CannotPurchaseOwnCourse;
    if (this.activeEnrollment(userId, courseId)) return ErrorCode.AlreadyEnrolled;
    return null;
  }

  /* ---------------------------------------------------------------- coupons */

  couponState(coupon: Coupon): CouponState {
    const now = this.now().getTime();
    if (coupon.deactivatedAt !== null) return 'DEACTIVATED';
    if (now >= Date.parse(coupon.endsAt)) return 'EXPIRED';
    if (now < Date.parse(coupon.startsAt)) return 'SCHEDULED';
    const used = coupon.redemptions.reserved + coupon.redemptions.consumed;
    if (coupon.maxRedemptions !== null && used >= coupon.maxRedemptions) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  private couponView(coupon: Coupon): Coupon {
    return { ...coupon, state: this.couponState(coupon) };
  }

  private couponsFor(code: string, courseId: string): Coupon[] {
    return this.coupons.filter(
      (c) => c.code === code && (c.scope === 'PLATFORM' || c.courseId === courseId),
    );
  }

  /** Why `code` does not apply to the cart, or null when it applies to at least one line. */
  private couponProblem(code: string, courseIds: readonly string[]): CouponProblemCode | null {
    const matching = courseIds.flatMap((id) => this.couponsFor(code, id));
    if (matching.length === 0) return ErrorCode.CouponInvalid;
    const states = matching.map((c) => this.couponState(c));
    if (states.includes('ACTIVE')) {
      const usable = matching.filter(
        (c) => this.couponState(c) === 'ACTIVE' && !this.usedByViewer(c.id),
      );
      return usable.length > 0 ? null : ErrorCode.CouponAlreadyUsed;
    }
    if (states.includes('EXHAUSTED')) return ErrorCode.CouponExhausted;
    if (states.includes('SCHEDULED')) return ErrorCode.CouponNotStarted;
    if (states.includes('EXPIRED')) return ErrorCode.CouponExpired;
    return ErrorCode.CouponInvalid; // only deactivated ones
  }

  /**
   * One redemption per user per coupon (D5). The viewer's own open (PENDING_PAYMENT) order does
   * not count, so the quote of a pending checkout stays stable and the same key resumes.
   */
  private usedByViewer(couponId: string): boolean {
    const holder = this.redeemed.get(`${couponId}:${this.viewerId}`);
    if (holder === undefined) return false;
    return this.orders.find((o) => o.id === holder)?.status !== 'PENDING_PAYMENT';
  }

  /** D5: the best of {course coupon, platform coupon} with this code; a tie goes to the course. */
  private bestCoupon(code: string | null, courseId: string, listAmount: string) {
    if (code === null) return null;
    let best: { coupon: Coupon; discount: string } | null = null;
    for (const coupon of this.couponsFor(code, courseId)) {
      if (this.couponState(coupon) !== 'ACTIVE') continue;
      if (this.usedByViewer(coupon.id)) continue;
      const discount =
        coupon.discountType === 'PERCENT'
          ? discountFor(listAmount, { discountType: 'PERCENT', percentOff: coupon.percentOff ?? 0 })
          : discountFor(listAmount, {
              discountType: 'AMOUNT',
              amountOff: coupon.amountOff ?? '0.00',
            });
      const better =
        best === null ||
        moneyToMinor(discount) > moneyToMinor(best.discount) ||
        (discount === best.discount && coupon.scope === 'COURSE');
      if (better) best = { coupon, discount };
    }
    return best;
  }

  /* ---------------------------------------------------------------- pricing */

  publicPrices(courseIds: readonly string[]): PublicPrice[] {
    return courseIds.flatMap((courseId) => {
      const course = this.courses.get(courseId);
      if (!course || course.status !== 'PUBLISHED' || course.price === null) return [];
      return [
        { courseId, amount: course.price, currency: 'USD', isFree: isFreeAmount(course.price) },
      ];
    });
  }

  coursePricing(courseId: string): CoursePricing {
    const course = this.ownCourse(courseId);
    return {
      courseId,
      price: course.price === null ? null : { amount: course.price, currency: 'USD' },
      isFree: course.price !== null && isFreeAmount(course.price),
      history: [...(this.priceHistory.get(courseId) ?? [])].reverse().slice(0, 20),
    };
  }

  setCoursePrice(courseId: string, amount: string): CoursePricing {
    const course = this.ownCourse(courseId);
    if (!isPriceTier(amount, 'USD')) throw new MockApiError(422, ErrorCode.PriceNotAllowed);
    if (course.price !== amount) {
      const history = this.priceHistory.get(courseId) ?? [];
      history.push({
        id: this.nextId(),
        previousAmount: course.price,
        amount,
        currency: 'USD',
        changedBy: this.viewerId,
        changedAt: this.iso(),
      });
      this.priceHistory.set(courseId, history);
      course.price = amount;
    }
    return this.coursePricing(courseId);
  }

  /* ---------------------------------------------------------------- cart */

  quote(): CartQuote {
    const lines: CartLine[] = [];
    const unavailable: CartUnavailableLine[] = [];
    for (const item of this.cartItems) {
      const course = this.courses.get(item.courseId);
      const reason = this.purchaseBlock(item.courseId);
      if (reason !== null || !course || course.price === null) {
        unavailable.push({
          courseId: item.courseId,
          title: course?.title ?? null,
          reason: reason ?? ErrorCode.CourseNotForSale,
          addedAt: item.addedAt,
        });
        continue;
      }
      const best = this.bestCoupon(this.cartCouponCode, course.id, course.price);
      const discountAmount = best?.discount ?? '0.00';
      lines.push({
        courseId: course.id,
        slug: course.slug,
        title: course.title,
        instructor: this.person(course.ownerId),
        hasThumbnail: course.hasThumbnail ?? false,
        listAmount: course.price,
        discountAmount,
        finalAmount: subtractMoneyFloored(course.price, discountAmount),
        couponId: best && discountAmount !== '0.00' ? best.coupon.id : null,
        addedAt: item.addedAt,
      });
    }
    const code = this.cartCouponCode;
    const problem =
      code === null
        ? null
        : this.couponProblem(
            code,
            lines.map((l) => l.courseId),
          );
    const couponIds = [...new Set(lines.flatMap((l) => (l.couponId ? [l.couponId] : [])))];
    return {
      currency: 'USD',
      lines,
      unavailable,
      coupon: code === null ? null : { code, applied: problem === null, problem },
      totals: {
        listAmount: sumMoney(lines.map((l) => l.listAmount)),
        discountAmount: sumMoney(lines.map((l) => l.discountAmount)),
        totalAmount: sumMoney(lines.map((l) => l.finalAmount)),
      },
      itemCount: lines.length + unavailable.length,
      fingerprint: fixtureFingerprint(
        `${lines
          .map((l) => `${l.courseId}:${l.finalAmount}`)
          .sort()
          .join('|')}|${couponIds.sort().join(',')}|USD`,
      ),
    };
  }

  private addItem(courseId: string): 'ADDED' | 'PRESENT' {
    if (this.cartItems.some((i) => i.courseId === courseId)) return 'PRESENT';
    const reason = this.purchaseBlock(courseId);
    if (reason === ErrorCode.CourseNotFound) throw new MockApiError(404, reason);
    if (reason !== null) throw new MockApiError(409, reason);
    if (this.cartItems.length >= 20) throw new MockApiError(422, ErrorCode.CartFull);
    this.cartItems.push({ courseId, addedAt: this.iso() });
    return 'ADDED';
  }

  addToCart(courseId: string): CartQuote {
    this.addItem(courseId);
    return this.quote();
  }

  removeFromCart(courseId: string): CartQuote {
    this.cartItems = this.cartItems.filter((i) => i.courseId !== courseId);
    return this.quote();
  }

  mergeGuestCart(courseIds: readonly string[]) {
    const added: string[] = [];
    const skipped: { courseId: string; reason: MergeSkipReason }[] = [];
    for (const courseId of courseIds) {
      try {
        if (this.addItem(courseId) === 'ADDED') added.push(courseId);
      } catch (error) {
        if (!(error instanceof MockApiError)) throw error;
        skipped.push({ courseId, reason: error.code as MergeSkipReason });
      }
    }
    return { quote: this.quote(), added, skipped };
  }

  applyCoupon(code: string): CartQuote {
    const courseIds = this.quote().lines.map((l) => l.courseId);
    const problem = this.couponProblem(code, courseIds);
    if (problem !== null) throw new MockApiError(422, problem);
    this.cartCouponCode = code;
    return this.quote();
  }

  removeCoupon(): CartQuote {
    this.cartCouponCode = null;
    return this.quote();
  }

  purchaseStates(courseIds: readonly string[]): PurchaseState[] {
    return courseIds.map((courseId) => ({
      courseId,
      enrolled: this.activeEnrollment(this.viewerId, courseId) !== undefined,
      inCart: this.cartItems.some((i) => i.courseId === courseId),
      isOwner: this.courses.get(courseId)?.ownerId === this.viewerId,
    }));
  }

  /* ---------------------------------------------------------------- checkout */

  checkout(idempotencyKey: string | null, expectedTotal: string) {
    if (idempotencyKey === null) throw new MockApiError(400, ErrorCode.IdempotencyKeyRequired);
    if (!this.emailVerified) throw new MockApiError(403, ErrorCode.EmailNotVerified);
    const quote = this.quote();
    const existing = this.orders.find(
      (o) => o.userId === this.viewerId && o.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      // §5: same fingerprint resumes; a different cart under the same key is a reuse
      if (existing.fingerprint !== quote.fingerprint) {
        throw new MockApiError(422, ErrorCode.IdempotencyKeyReused);
      }
      return { orderId: existing.id, status: existing.status, checkoutUrl: existing.checkoutUrl };
    }
    const open = this.orders.find(
      (o) => o.userId === this.viewerId && o.status === 'PENDING_PAYMENT',
    );
    if (open) {
      throw new MockApiError(409, ErrorCode.CheckoutInProgress, {
        orderId: open.id,
        checkoutUrl: open.checkoutUrl,
      });
    }
    if (quote.unavailable.length > 0) throw new MockApiError(409, ErrorCode.CartChanged, { quote });
    if (quote.lines.length === 0) throw new MockApiError(422, ErrorCode.CartEmpty);
    if (quote.totals.totalAmount !== expectedTotal) {
      throw new MockApiError(409, ErrorCode.PriceChanged, { quote });
    }
    const totalMinor = moneyToMinor(quote.totals.totalAmount);
    if (totalMinor > 0 && totalMinor < MIN_CHARGE_MINOR) {
      throw new MockApiError(422, ErrorCode.AmountBelowMinimum);
    }

    const order = this.createOrder(this.viewerId, quote, idempotencyKey);
    if (totalMinor === 0) {
      this.transition(order, 'PAID', 'ZERO_TOTAL', { actorId: this.viewerId });
      this.settlePaid(order);
    } else {
      this.transition(order, 'PENDING_PAYMENT', 'CHECKOUT', { actorId: this.viewerId });
      order.paymentStatus = 'OPEN';
      order.sessionId = `cs_test_${order.orderNumber}`;
      order.checkoutUrl = `${this.checkoutOrigin}/pay/${order.sessionId}`;
    }
    return { orderId: order.id, status: order.status, checkoutUrl: order.checkoutUrl };
  }

  private createOrder(userId: string, quote: CartQuote, idempotencyKey: string | null): MockOrder {
    this.orderNumber += 1;
    const couponId = quote.lines.find((l) => l.couponId !== null)?.couponId ?? null;
    const order: MockOrder = {
      id: this.nextId(),
      orderNumber: this.orderNumber,
      userId,
      status: 'PENDING_PAYMENT',
      idempotencyKey,
      fingerprint: quote.fingerprint,
      placedAt: this.iso(),
      paidAt: null,
      closedAt: null,
      lines: quote.lines.map((line, index) => ({
        id: this.nextId(),
        lineNo: index + 1,
        courseId: line.courseId,
        courseTitle: line.title,
        instructorId: this.courses.get(line.courseId)?.ownerId ?? FIXTURE_IDS.instructor,
        listAmount: line.listAmount,
        discountAmount: line.discountAmount,
        finalAmount: line.finalAmount,
        couponId: line.couponId,
        couponCode: line.couponId === null ? null : (quote.coupon?.code ?? null),
        revenueShareBps: DEFAULT_REVENUE_SHARE_BPS,
      })),
      paymentStatus: null,
      sessionId: null,
      checkoutUrl: null,
      couponId,
      transitions: [],
    };
    const coupon = this.coupons.find((c) => c.id === couponId);
    if (coupon) {
      coupon.redemptions.reserved += 1;
      this.redeemed.set(`${coupon.id}:${userId}`, order.id);
    }
    this.orders.push(order);
    return order;
  }

  private settlePaid(order: MockOrder): void {
    order.paidAt = this.iso();
    if (order.paymentStatus !== null) order.paymentStatus = 'SUCCEEDED';
    order.checkoutUrl = null;
    const coupon = this.coupons.find((c) => c.id === order.couponId);
    if (coupon) {
      coupon.redemptions.reserved = Math.max(0, coupon.redemptions.reserved - 1);
      coupon.redemptions.consumed += 1;
    }
    for (const line of order.lines) {
      this.grant(order.userId, line.courseId, 'ORDER', line.id, null, null);
    }
    if (order.userId === this.viewerId) {
      const bought = new Set(order.lines.map((l) => l.courseId));
      this.cartItems = this.cartItems.filter((i) => !bought.has(i.courseId));
      if (coupon) this.cartCouponCode = null;
    }
  }

  private release(order: MockOrder): void {
    order.paymentStatus = order.paymentStatus === null ? null : 'EXPIRED';
    order.checkoutUrl = null;
    order.closedAt = this.iso();
    const coupon = this.coupons.find((c) => c.id === order.couponId);
    if (coupon) {
      coupon.redemptions.reserved = Math.max(0, coupon.redemptions.reserved - 1);
      this.redeemed.delete(`${coupon.id}:${order.userId}`);
    }
  }

  /** Simulates `checkout.session.completed` (paid) for a PENDING_PAYMENT order. */
  completePayment(orderId: string): OrderDetail {
    const order = this.order(orderId, false);
    if (order.status === 'PENDING_PAYMENT') {
      this.transition(order, 'PAID', 'PROVIDER_EVENT', {
        providerEventId: `evt_test_${order.orderNumber}`,
      });
      this.settlePaid(order);
    }
    return this.orderDetail(order);
  }

  /** Simulates `checkout.session.expired`. */
  expirePayment(orderId: string): OrderDetail {
    const order = this.order(orderId, false);
    if (order.status === 'PENDING_PAYMENT') {
      this.transition(order, 'EXPIRED', 'PROVIDER_EVENT', {
        providerEventId: `evt_test_exp_${order.orderNumber}`,
      });
      this.release(order);
    }
    return this.orderDetail(order);
  }

  cancelOrder(orderId: string): OrderDetail {
    const order = this.order(orderId, true);
    if (order.status === 'PENDING_PAYMENT') {
      this.transition(order, 'CANCELED', 'USER_CANCEL', { actorId: this.viewerId });
      this.release(order);
    } else if (order.status !== 'CANCELED' && order.status !== 'EXPIRED') {
      throw new MockApiError(409, ErrorCode.OrderNotCancelable);
    }
    return this.orderDetail(order);
  }

  /**
   * Seeds a PAID order (e.g. sales for an instructor, or orders for the admin search) without
   * touching the viewer's cart. Prices come from the courses; no coupon.
   */
  seedPaidOrder(userId: string, courseIds: readonly string[]): OrderDetail {
    const lines = courseIds.map((courseId): CartLine => {
      const course = this.courses.get(courseId);
      if (!course || course.price === null) throw new Error(`Unknown or unpriced ${courseId}`);
      return {
        courseId,
        slug: course.slug,
        title: course.title,
        instructor: this.person(course.ownerId),
        hasThumbnail: course.hasThumbnail ?? false,
        listAmount: course.price,
        discountAmount: '0.00',
        finalAmount: course.price,
        couponId: null,
        addedAt: this.iso(),
      };
    });
    const quote: CartQuote = {
      ...this.quote(),
      lines,
      unavailable: [],
      coupon: null,
      fingerprint: fixtureFingerprint(`seed:${this.seq}`),
    };
    const order = this.createOrder(userId, quote, null);
    const zero = sumMoney(lines.map((l) => l.finalAmount)) === '0.00';
    this.transition(order, zero ? 'PAID' : 'PENDING_PAYMENT', zero ? 'ZERO_TOTAL' : 'CHECKOUT', {
      actorId: userId,
    });
    if (!zero) {
      order.paymentStatus = 'OPEN';
      order.sessionId = `cs_test_${order.orderNumber}`;
      this.transition(order, 'PAID', 'PROVIDER_EVENT', {
        providerEventId: `evt_test_${order.orderNumber}`,
      });
    }
    order.paymentStatus = zero ? null : 'OPEN';
    this.settlePaid(order);
    return this.orderDetail(order);
  }

  /* ---------------------------------------------------------------- orders */

  private refundOfLine(lineId: string): MockRefund | undefined {
    const forLine = this.refunds.filter((r) => r.orderLineId === lineId);
    return forLine.find((r) => r.status !== 'REJECTED' && r.status !== 'FAILED') ?? forLine.at(-1);
  }

  private lineRefundBlock(order: MockOrder, line: MockLine): RefundBlockReason | null {
    const live = this.refundOfLine(line.id);
    if (live && live.status !== 'REJECTED' && live.status !== 'FAILED') {
      return ErrorCode.RefundAlreadyRequested;
    }
    if (order.paidAt === null || line.finalAmount === '0.00') return ErrorCode.RefundNotApplicable;
    if (order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') {
      return ErrorCode.RefundNotApplicable;
    }
    const until = Date.parse(order.paidAt) + this.refundWindowDays * DAY_MS;
    if (this.now().getTime() > until) return ErrorCode.RefundWindowClosed;
    return null;
  }

  private refundedAmount(order: MockOrder): string {
    return sumMoney(
      this.refunds
        .filter((r) => r.orderId === order.id && r.status === 'SUCCEEDED')
        .map((r) => r.amount),
    );
  }

  private orderDetail(order: MockOrder): OrderDetail {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: 'USD',
      subtotalAmount: sumMoney(order.lines.map((l) => l.listAmount)),
      discountAmount: sumMoney(order.lines.map((l) => l.discountAmount)),
      totalAmount: sumMoney(order.lines.map((l) => l.finalAmount)),
      refundedAmount: this.refundedAmount(order),
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      closedAt: order.closedAt,
      lines: order.lines.map((line) => {
        const refund = this.refundOfLine(line.id);
        const block = this.lineRefundBlock(order, line);
        const refundable = order.paidAt !== null && line.finalAmount !== '0.00';
        return {
          id: line.id,
          lineNo: line.lineNo,
          courseId: line.courseId,
          slug: this.courses.get(line.courseId)?.slug ?? null,
          courseTitle: line.courseTitle,
          instructor: this.person(line.instructorId),
          listAmount: line.listAmount,
          discountAmount: line.discountAmount,
          finalAmount: line.finalAmount,
          couponCode: line.couponCode,
          refund: {
            refundId: refund?.id ?? null,
            status: refund?.status ?? null,
            refundableUntil:
              refundable && order.paidAt
                ? new Date(Date.parse(order.paidAt) + this.refundWindowDays * DAY_MS).toISOString()
                : null,
            eligible: block === null,
            reason: block,
          },
        };
      }),
      payment: {
        provider: order.paymentStatus === null ? 'NONE' : 'STRIPE',
        status: order.paymentStatus,
      },
      checkoutUrl: order.checkoutUrl,
    };
  }

  myOrders(): OrderSummary[] {
    return this.orders
      .filter((o) => o.userId === this.viewerId)
      .reverse()
      .map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        currency: 'USD',
        totalAmount: sumMoney(o.lines.map((l) => l.finalAmount)),
        lineCount: o.lines.length,
        courseTitles: o.lines.map((l) => l.courseTitle),
        placedAt: o.placedAt,
        paidAt: o.paidAt,
      }));
  }

  myOrder(orderId: string): OrderDetail {
    return this.orderDetail(this.order(orderId, true));
  }

  receipt(orderId: string): Receipt {
    const order = this.order(orderId, true);
    if (order.paidAt === null) throw new MockApiError(409, ErrorCode.OrderNotPaid);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      issuedAt: order.paidAt,
      buyer: { displayName: this.users.get(order.userId)?.displayName ?? 'Student' },
      currency: 'USD',
      lines: order.lines.map((l) => ({
        courseTitle: l.courseTitle,
        listAmount: l.listAmount,
        discountAmount: l.discountAmount,
        finalAmount: l.finalAmount,
        couponCode: l.couponCode,
      })),
      subtotalAmount: sumMoney(order.lines.map((l) => l.listAmount)),
      discountAmount: sumMoney(order.lines.map((l) => l.discountAmount)),
      totalAmount: sumMoney(order.lines.map((l) => l.finalAmount)),
      refundedAmount: this.refundedAmount(order),
      paymentProvider: order.paymentStatus === null ? 'NONE' : 'STRIPE',
    };
  }

  /* ---------------------------------------------------------------- refunds */

  private createRefund(
    order: MockOrder,
    line: MockLine,
    input: {
      initiatedBy: RefundInitiator;
      reasonCode: RefundReasonCode;
      comment: string | null;
      approve: boolean;
      actorId: string | null;
      /** ADMIN: the reason on the first transition. */
      reason?: string | null;
    },
  ): MockRefund {
    const at = this.iso();
    const refund: MockRefund = {
      id: this.nextId(),
      orderId: order.id,
      orderLineId: line.id,
      courseId: line.courseId,
      courseTitle: line.courseTitle,
      amount: line.finalAmount,
      currency: 'USD',
      status: input.approve ? 'APPROVED' : 'REQUESTED',
      initiatedBy: input.initiatedBy,
      reasonCode: input.reasonCode,
      comment: input.comment,
      rejectionReason: null,
      attempt: 1,
      createdAt: at,
      approvedAt: input.approve ? at : null,
      succeededAt: null,
      userId: order.userId,
      requestedBy: input.initiatedBy === 'STUDENT' ? order.userId : null,
      providerRefundId: null,
      failureCode: null,
      transitions: [],
    };
    this.refundTransition(refund, refund.status, {
      actorId: input.initiatedBy === 'STUDENT' ? order.userId : input.actorId,
      reason: input.reason ?? null,
    });
    this.refunds.push(refund);
    if (input.approve) this.revokeFor(refund, input.actorId);
    return refund;
  }

  private revokeFor(refund: MockRefund, actorId: string | null): void {
    const enrollment = this.activeEnrollment(refund.userId, refund.courseId);
    if (enrollment) this.revoke(enrollment, 'REFUND', refund.id, actorId, null);
  }

  /**
   * D11 abuse count (`recentRefundCount`): the user's other STUDENT refunds, not REJECTED,
   * created in the lookback window before `at` (≥ 3 sends a request to admin review).
   */
  private recentRefundCount(userId: string, at = this.iso(), exceptId?: string): number {
    const until = Date.parse(at);
    const since = until - REFUND_REVIEW_LOOKBACK_DAYS * DAY_MS;
    return this.refunds.filter(
      (r) =>
        r.id !== exceptId &&
        r.userId === userId &&
        r.initiatedBy === 'STUDENT' &&
        r.status !== 'REJECTED' &&
        Date.parse(r.createdAt) >= since &&
        Date.parse(r.createdAt) <= until,
    ).length;
  }

  requestRefund(
    orderId: string,
    input: { orderLineId: string; reasonCode: RefundReasonCode; comment?: string },
  ): Refund {
    const order = this.order(orderId, true);
    const line = order.lines.find((l) => l.id === input.orderLineId);
    if (!line) throw new MockApiError(404, ErrorCode.OrderNotFound);
    const block = this.lineRefundBlock(order, line);
    if (block === ErrorCode.RefundAlreadyRequested) throw new MockApiError(409, block);
    if (block !== null) throw new MockApiError(422, block);
    const approve = this.recentRefundCount(order.userId) < REFUND_REVIEW_THRESHOLD;
    return this.studentView(
      this.createRefund(order, line, {
        initiatedBy: 'STUDENT',
        reasonCode: input.reasonCode,
        comment: input.comment ?? null,
        approve,
        actorId: null,
      }),
    );
  }

  private studentView(refund: MockRefund): Refund {
    return {
      id: refund.id,
      orderId: refund.orderId,
      orderLineId: refund.orderLineId,
      courseId: refund.courseId,
      courseTitle: refund.courseTitle,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
      initiatedBy: refund.initiatedBy,
      reasonCode: refund.reasonCode,
      comment: refund.comment,
      rejectionReason: refund.rejectionReason,
      attempt: refund.attempt,
      createdAt: refund.createdAt,
      approvedAt: refund.approvedAt,
      succeededAt: refund.succeededAt,
    };
  }

  private refundById(refundId: string): MockRefund {
    const refund = this.refunds.find((r) => r.id === refundId);
    if (!refund) throw new MockApiError(404, ErrorCode.RefundNotFound);
    return refund;
  }

  /** Simulates the provider outcome of an APPROVED/SUBMITTED refund (dispatcher + webhook). */
  settleRefund(refundId: string, outcome: 'SUCCEEDED' | 'FAILED'): AdminRefund {
    const refund = this.refundById(refundId);
    if (refund.status !== 'APPROVED' && refund.status !== 'SUBMITTED') return { ...refund };
    if (outcome === 'FAILED') {
      refund.failureCode = 'charge_disputed';
      this.refundTransition(refund, 'FAILED', { failureCode: refund.failureCode });
      return { ...refund };
    }
    refund.succeededAt = this.iso();
    refund.providerRefundId = `re_test_${refund.id.slice(-6)}`;
    this.refundTransition(refund, 'SUCCEEDED');
    const order = this.order(refund.orderId, false);
    const done = order.lines.every((l) =>
      this.refunds.some((r) => r.orderLineId === l.id && r.status === 'SUCCEEDED'),
    );
    this.transition(order, done ? 'REFUNDED' : 'PARTIALLY_REFUNDED', 'REFUND');
    return { ...refund };
  }

  adminRefundLines(orderId: string, lineIds: readonly string[], reason: string): AdminRefund[] {
    const order = this.order(orderId, false);
    const review = order.status === 'PAYMENT_REVIEW';
    if (!review && order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') {
      throw new MockApiError(422, ErrorCode.RefundNotApplicable);
    }
    if (review && order.lines.some((l) => l.finalAmount !== '0.00' && !lineIds.includes(l.id))) {
      // A PAYMENT_REVIEW order is refunded as a whole.
      throw new MockApiError(422, ErrorCode.RefundNotApplicable);
    }
    const lines = lineIds.map((id) => {
      const line = order.lines.find((l) => l.id === id);
      if (!line) throw new MockApiError(404, ErrorCode.OrderNotFound);
      const live = this.refundOfLine(line.id);
      if (live && live.status !== 'REJECTED' && live.status !== 'FAILED') {
        throw new MockApiError(409, ErrorCode.RefundAlreadyRequested);
      }
      if (line.finalAmount === '0.00') {
        throw new MockApiError(422, ErrorCode.RefundNotApplicable);
      }
      return line;
    });
    return lines.map((line) => {
      const refund = this.createRefund(order, line, {
        initiatedBy: 'ADMIN',
        reasonCode: review ? 'PAYMENT_REVIEW' : 'ADMIN_DISCRETION',
        // Only students leave comments; the admin's reason is on the transition.
        comment: null,
        approve: true,
        actorId: this.viewerId,
        reason,
      });
      return { ...refund };
    });
  }

  acceptPayment(orderId: string, reason: string): AdminOrderDetail {
    const order = this.order(orderId, false);
    const refunded = this.refunds.some(
      (r) => r.orderId === order.id && r.status !== 'REJECTED' && r.status !== 'FAILED',
    );
    if (order.status !== 'PAYMENT_REVIEW' || refunded) {
      throw new MockApiError(409, ErrorCode.InvalidStateTransition);
    }
    order.paidAt = this.iso();
    this.transition(order, 'PAID', 'ADMIN', { actorId: this.viewerId, reason });
    for (const line of order.lines) {
      this.grant(order.userId, line.courseId, 'ORDER', line.id, null, null);
    }
    return this.adminOrder(orderId);
  }

  /** Moves a PENDING_PAYMENT order to PAYMENT_REVIEW (an amount mismatch). */
  flagPaymentMismatch(orderId: string): AdminOrderDetail {
    const order = this.order(orderId, false);
    if (order.status === 'PENDING_PAYMENT') {
      this.transition(order, 'PAYMENT_REVIEW', 'PROVIDER_EVENT', {
        providerEventId: `evt_test_mm_${order.orderNumber}`,
      });
      // PAYMENT_REVIEW has no paid_at: the order is accepted as paid only by an admin.
      order.paymentStatus = 'SUCCEEDED';
      order.checkoutUrl = null;
    }
    return this.adminOrder(orderId);
  }

  refundQueue(status: RefundStatus): AdminRefundQueueItem[] {
    return this.refunds.filter((r) => r.status === status).map((r) => this.queueItem(r));
  }

  private queueItem(refund: MockRefund): AdminRefundQueueItem {
    const order = this.order(refund.orderId, false);
    return {
      ...refund,
      orderNumber: order.orderNumber,
      buyer: this.buyer(refund.userId),
      recentRefundCount: this.recentRefundCount(refund.userId, refund.createdAt, refund.id),
    };
  }

  decideRefund(
    refundId: string,
    decision: 'approve' | 'reject' | 'retry',
    reason?: string,
  ): AdminRefundQueueItem {
    const refund = this.refundById(refundId);
    const expected: RefundStatus = decision === 'retry' ? 'FAILED' : 'REQUESTED';
    if (refund.status !== expected) throw new MockApiError(409, ErrorCode.InvalidStateTransition);
    if (decision === 'reject') {
      refund.rejectionReason = reason ?? null;
      this.refundTransition(refund, 'REJECTED', { actorId: this.viewerId, reason });
    } else {
      refund.failureCode = null;
      refund.providerRefundId = null;
      refund.approvedAt = this.iso();
      if (decision === 'retry') refund.attempt += 1;
      this.refundTransition(refund, 'APPROVED', { actorId: this.viewerId, reason });
      this.revokeFor(refund, this.viewerId);
    }
    return this.queueItem(refund);
  }

  /* ---------------------------------------------------------------- admin orders */

  adminOrders(filter: {
    q?: number;
    buyerEmail?: string;
    status?: OrderStatus;
    userId?: string;
    courseId?: string;
    from?: string;
    to?: string;
  }): AdminOrderRow[] {
    return [...this.orders]
      .reverse()
      .filter(
        (o) =>
          (filter.q === undefined || o.orderNumber === filter.q) &&
          (filter.buyerEmail === undefined ||
            (this.users
              .get(o.userId)
              ?.email.toLowerCase()
              .includes(filter.buyerEmail.toLowerCase()) ??
              false)) &&
          (filter.status === undefined || o.status === filter.status) &&
          (filter.userId === undefined || o.userId === filter.userId) &&
          (filter.courseId === undefined || o.lines.some((l) => l.courseId === filter.courseId)) &&
          (filter.from === undefined || Date.parse(o.placedAt) >= Date.parse(filter.from)) &&
          (filter.to === undefined || Date.parse(o.placedAt) < Date.parse(filter.to)),
      )
      .map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        currency: 'USD',
        totalAmount: sumMoney(o.lines.map((l) => l.finalAmount)),
        lineCount: o.lines.length,
        buyer: this.buyer(o.userId),
        placedAt: o.placedAt,
        paidAt: o.paidAt,
      }));
  }

  /** Order transitions, payment milestones and refund transitions, oldest first. */
  private timeline(order: MockOrder): AdminOrderTimelineEntry[] {
    const none = {
      refundId: null,
      cause: null,
      actorId: null,
      actor: null,
      reason: null,
      providerEventId: null,
      providerRefundId: null,
      failureCode: null,
    };
    const rank = { ORDER: 0, PAYMENT: 1, REFUND: 2 } as const;
    const entries: AdminOrderTimelineEntry[] = [
      ...order.transitions.map((t) => ({
        ...none,
        kind: 'ORDER' as const,
        at: t.occurredAt,
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        cause: t.cause,
        actorId: t.actorId,
        actor: t.actor,
        reason: t.reason,
        providerEventId: t.providerEventId,
      })),
      ...(order.paymentStatus === null
        ? []
        : [
            {
              ...none,
              kind: 'PAYMENT' as const,
              at: order.placedAt,
              fromStatus: null,
              toStatus: 'CREATING' as const,
            },
            ...(order.paymentStatus === 'SUCCEEDED' && order.paidAt !== null
              ? [
                  {
                    ...none,
                    kind: 'PAYMENT' as const,
                    at: order.paidAt,
                    fromStatus: null,
                    toStatus: 'SUCCEEDED' as const,
                  },
                ]
              : []),
          ]),
      ...this.refunds
        .filter((r) => r.orderId === order.id)
        .flatMap((r) =>
          r.transitions.map((t) => ({
            ...none,
            kind: 'REFUND' as const,
            at: t.occurredAt,
            refundId: r.id,
            fromStatus: t.fromStatus,
            toStatus: t.toStatus,
            actorId: t.actorId,
            actor: t.actor,
            reason: t.reason,
            providerRefundId: t.providerRefundId,
            failureCode: t.failureCode,
          })),
        ),
    ];
    return entries.sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || rank[a.kind] - rank[b.kind],
    );
  }

  adminOrder(orderId: string): AdminOrderDetail {
    const order = this.order(orderId, false);
    const detail = this.orderDetail(order);
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: 'USD',
      subtotalAmount: detail.subtotalAmount,
      discountAmount: detail.discountAmount,
      totalAmount: detail.totalAmount,
      refundedAmount: detail.refundedAmount,
      settlement: order.paymentStatus === null ? 'NONE' : 'STRIPE',
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      closedAt: order.closedAt,
      buyer: this.buyer(order.userId),
      lines: order.lines.map((l) => {
        const instructorShareAmount = instructorShareOf(l.finalAmount, l.revenueShareBps);
        return {
          ...l,
          instructor: this.person(l.instructorId),
          instructorShareAmount,
          platformShareAmount: subtractMoneyFloored(l.finalAmount, instructorShareAmount),
        };
      }),
      payment:
        order.paymentStatus === null
          ? null
          : {
              id: fixtureId(0xa000 + order.orderNumber),
              provider: 'STRIPE',
              status: order.paymentStatus,
              amount: detail.totalAmount,
              currency: 'USD',
              checkoutSessionId: order.sessionId,
              paymentIntentId: order.paidAt === null ? null : `pi_test_${order.orderNumber}`,
              sessionExpiresAt:
                order.sessionId === null
                  ? null
                  : new Date(Date.parse(order.placedAt) + 30 * 60 * 1000).toISOString(),
              succeededAt: order.paymentStatus === 'SUCCEEDED' ? order.paidAt : null,
              createdAt: order.placedAt,
            },
      transitions: [...order.transitions],
      refunds: this.refunds
        .filter((r) => r.orderId === order.id)
        .map((r) => ({ ...r, transitions: [...r.transitions] })),
      timeline: this.timeline(order),
      providerEvents: order.transitions.flatMap((t) =>
        t.providerEventId === null
          ? []
          : [
              {
                provider: 'STRIPE' as const,
                eventId: t.providerEventId,
                type:
                  t.toStatus === 'EXPIRED'
                    ? 'checkout.session.expired'
                    : 'checkout.session.completed',
                livemode: false,
                objectId: order.sessionId ?? 'cs_test',
                providerCreatedAt: t.occurredAt,
                receivedAt: t.occurredAt,
                processedAt: t.occurredAt,
                outcome:
                  t.toStatus === 'PAYMENT_REVIEW' ? ('MISMATCH' as const) : ('APPLIED' as const),
              },
            ],
      ),
    };
  }

  /* ---------------------------------------------------------------- coupons (write) */

  listCoupons(courseId: string | null): Coupon[] {
    if (courseId !== null) this.ownCourse(courseId);
    return this.coupons
      .filter((c) => (courseId === null ? c.scope === 'PLATFORM' : c.courseId === courseId))
      .reverse()
      .map((c) => this.couponView(c));
  }

  createCoupon(
    courseId: string | null,
    input: {
      code: string;
      discountType: 'PERCENT' | 'AMOUNT';
      percentOff?: number;
      amountOff?: string;
      startsAt?: string;
      endsAt: string;
      maxRedemptions?: number;
    },
  ): Coupon {
    if (courseId !== null) {
      const course = this.ownCourse(courseId);
      if (course.price !== null && isFreeAmount(course.price)) {
        throw new MockApiError(422, ErrorCode.CourseIsFree);
      }
      const active = this.coupons.filter((c) => {
        const state = this.couponState(c);
        return c.courseId === courseId && state !== 'DEACTIVATED' && state !== 'EXPIRED';
      });
      if (active.length >= 10) throw new MockApiError(422, ErrorCode.CouponLimitExceeded);
    }
    if (this.coupons.some((c) => c.courseId === courseId && c.code === input.code)) {
      throw new MockApiError(409, ErrorCode.CouponCodeTaken);
    }
    const coupon: Coupon = {
      id: this.nextId(),
      scope: courseId === null ? 'PLATFORM' : 'COURSE',
      courseId,
      code: input.code,
      discountType: input.discountType,
      percentOff: input.discountType === 'PERCENT' ? (input.percentOff ?? null) : null,
      amountOff: input.discountType === 'AMOUNT' ? (input.amountOff ?? null) : null,
      currency: input.discountType === 'AMOUNT' ? 'USD' : null,
      startsAt: input.startsAt ?? this.iso(),
      endsAt: input.endsAt,
      maxRedemptions: input.maxRedemptions ?? null,
      state: 'ACTIVE',
      redemptions: { reserved: 0, consumed: 0 },
      createdBy: this.viewerId,
      createdAt: this.iso(),
      deactivatedAt: null,
    };
    this.coupons.push(coupon);
    return this.couponView(coupon);
  }

  deactivateCoupon(courseId: string | null, couponId: string): Coupon {
    if (courseId !== null) this.ownCourse(courseId);
    const coupon = this.coupons.find(
      (c) =>
        c.id === couponId && (courseId === null ? c.scope === 'PLATFORM' : c.courseId === courseId),
    );
    if (!coupon) throw new MockApiError(404, ErrorCode.NotFound);
    coupon.deactivatedAt ??= this.iso();
    return this.couponView(coupon);
  }

  /* ---------------------------------------------------------------- enrollment */

  private grant(
    userId: string,
    courseId: string,
    source: EnrollmentSource,
    orderLineId: string | null,
    actorId: string | null,
    reason: string | null,
  ): { enrollment: MockEnrollment; outcome: 'GRANTED' | 'REGRANTED' | 'ALREADY_ACTIVE' } {
    const existing = this.enrollments.find((e) => e.userId === userId && e.courseId === courseId);
    const at = this.iso();
    if (existing?.status === 'ACTIVE') return { enrollment: existing, outcome: 'ALREADY_ACTIVE' };
    const transition: EnrollmentTransition = {
      id: this.nextId(),
      action: existing ? 'REGRANT' : 'GRANT',
      source,
      orderLineId,
      refundId: null,
      reason,
      actorId,
      occurredAt: at,
    };
    if (existing) {
      Object.assign(existing, {
        status: 'ACTIVE',
        source,
        orderLineId,
        grantedAt: at,
        revokedAt: null,
        revokeReason: null,
      });
      existing.transitions.push(transition);
      return { enrollment: existing, outcome: 'REGRANTED' };
    }
    const enrollment: MockEnrollment = {
      id: this.nextId(),
      userId,
      courseId,
      status: 'ACTIVE',
      source,
      orderLineId,
      grantedAt: at,
      revokedAt: null,
      revokeReason: null,
      transitions: [transition],
    };
    this.enrollments.push(enrollment);
    return { enrollment, outcome: 'GRANTED' };
  }

  private revoke(
    enrollment: MockEnrollment,
    reason: EnrollmentRevokeReason,
    refundId: string | null,
    actorId: string | null,
    note: string | null,
  ): void {
    const at = this.iso();
    enrollment.status = 'REVOKED';
    enrollment.revokedAt = at;
    enrollment.revokeReason = reason;
    enrollment.transitions.push({
      id: this.nextId(),
      action: 'REVOKE',
      source: null,
      orderLineId: null,
      refundId,
      reason: note,
      actorId,
      occurredAt: at,
    });
  }

  private enrollmentView(e: MockEnrollment): Enrollment {
    return {
      id: e.id,
      userId: e.userId,
      courseId: e.courseId,
      status: e.status,
      source: e.source,
      orderLineId: e.orderLineId,
      grantedAt: e.grantedAt,
      revokedAt: e.revokedAt,
      revokeReason: e.revokeReason,
    };
  }

  /** `{ status: 201 | 200, enrollment }` like `POST /me/free-enrollments`. */
  enrollFree(courseId: string): { status: 200 | 201; enrollment: Enrollment } {
    const course = this.courses.get(courseId);
    if (!course) throw new MockApiError(404, ErrorCode.CourseNotFound);
    if (course.status !== 'PUBLISHED' || course.price === null) {
      throw new MockApiError(409, ErrorCode.CourseNotForSale);
    }
    if (!isFreeAmount(course.price)) throw new MockApiError(409, ErrorCode.CourseNotFree);
    if (course.ownerId === this.viewerId) {
      throw new MockApiError(409, ErrorCode.CannotPurchaseOwnCourse);
    }
    const { enrollment, outcome } = this.grant(this.viewerId, courseId, 'FREE', null, null, null);
    return {
      status: outcome === 'ALREADY_ACTIVE' ? 200 : 201,
      enrollment: this.enrollmentView(enrollment),
    };
  }

  myLearning(): LearningCard[] {
    return this.enrollments
      .filter((e) => e.userId === this.viewerId && e.status === 'ACTIVE')
      .sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt))
      .flatMap((e) => {
        const course = this.courses.get(e.courseId);
        if (!course) return [];
        return [
          {
            enrollmentId: e.id,
            courseId: course.id,
            slug: course.slug,
            title: course.title,
            instructor: this.person(course.ownerId),
            hasThumbnail: course.hasThumbnail ?? false,
            archived: course.status === 'ARCHIVED',
            source: e.source,
            grantedAt: e.grantedAt,
            progress: null,
          },
        ];
      });
  }

  private adminEnrollmentView(e: MockEnrollment): AdminEnrollment {
    const course = this.courses.get(e.courseId);
    return {
      ...this.enrollmentView(e),
      course: {
        id: e.courseId,
        slug: course?.slug ?? null,
        title: course?.title ?? null,
        archived: course?.status === 'ARCHIVED',
      },
      transitions: [...e.transitions],
    };
  }

  userEnrollments(userId: string): AdminEnrollment[] {
    if (!this.users.has(userId)) throw new MockApiError(404, ErrorCode.UserNotFound);
    return this.enrollments
      .filter((e) => e.userId === userId)
      .map((e) => this.adminEnrollmentView(e));
  }

  adminGrant(userId: string, courseId: string, reason: string): AdminEnrollment {
    if (!this.users.has(userId)) throw new MockApiError(404, ErrorCode.UserNotFound);
    if (!this.courses.has(courseId)) throw new MockApiError(404, ErrorCode.CourseNotFound);
    const { enrollment, outcome } = this.grant(
      userId,
      courseId,
      'ADMIN',
      null,
      this.viewerId,
      reason,
    );
    if (outcome === 'ALREADY_ACTIVE') throw new MockApiError(409, ErrorCode.AlreadyEnrolled);
    return this.adminEnrollmentView(enrollment);
  }

  adminRevoke(enrollmentId: string, reason: string): AdminEnrollment {
    const enrollment = this.enrollments.find((e) => e.id === enrollmentId);
    if (!enrollment) throw new MockApiError(404, ErrorCode.EnrollmentNotFound);
    if (enrollment.status !== 'ACTIVE') {
      throw new MockApiError(409, ErrorCode.InvalidStateTransition);
    }
    this.revoke(enrollment, 'ADMIN', null, this.viewerId, reason);
    return this.adminEnrollmentView(enrollment);
  }

  /* ---------------------------------------------------------------- sales */

  private soldLines(from?: string, to?: string) {
    return this.orders.flatMap((order) =>
      order.paidAt !== null &&
      ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.status) &&
      (from === undefined || Date.parse(order.paidAt) >= Date.parse(from)) &&
      (to === undefined || Date.parse(order.paidAt) < Date.parse(to))
        ? order.lines
            .filter((l) => l.instructorId === this.viewerId)
            .map((line) => ({
              order,
              line,
              refunded: this.refunds.some(
                (r) => r.orderLineId === line.id && r.status === 'SUCCEEDED',
              ),
            }))
        : [],
    );
  }

  private totals(rows: ReturnType<CommerceMockStore['soldLines']>): SalesTotals {
    const gross = sumMoney(rows.map((r) => r.line.listAmount));
    const discounts = sumMoney(rows.map((r) => r.line.discountAmount));
    const refunded = sumMoney(rows.filter((r) => r.refunded).map((r) => r.line.finalAmount));
    return {
      salesCount: rows.length,
      refundCount: rows.filter((r) => r.refunded).length,
      gross,
      discounts,
      refunded,
      net: subtractMoneyFloored(subtractMoneyFloored(gross, discounts), refunded),
      instructorShare: sumMoney(
        rows
          .filter((r) => !r.refunded)
          .map((r) => instructorShareOf(r.line.finalAmount, r.line.revenueShareBps)),
      ),
    };
  }

  salesSummary(from: string, to: string): SalesSummary {
    const rows = this.soldLines(from, to);
    const byCourse = new Map<string, typeof rows>();
    for (const row of rows) {
      byCourse.set(row.line.courseId, [...(byCourse.get(row.line.courseId) ?? []), row]);
    }
    return {
      from,
      to,
      currency: 'USD',
      totals: this.totals(rows),
      courses: [...byCourse.entries()]
        .map(([courseId, courseRows]) => ({
          ...this.totals(courseRows),
          courseId,
          courseTitle: courseRows.at(-1)?.line.courseTitle ?? 'Course',
        }))
        .sort((a, b) => moneyToMinor(b.net) - moneyToMinor(a.net)),
    };
  }

  recentSales(courseId?: string): RecentSale[] {
    return this.soldLines()
      .filter((r) => courseId === undefined || r.line.courseId === courseId)
      .reverse()
      .map(({ order, line, refunded }) => ({
        orderLineId: line.id,
        paidAt: order.paidAt ?? order.placedAt,
        courseId: line.courseId,
        courseTitle: line.courseTitle,
        currency: 'USD',
        listAmount: line.listAmount,
        finalAmount: line.finalAmount,
        couponCode: line.couponCode,
        instructorShareAmount: instructorShareOf(line.finalAmount, line.revenueShareBps),
        refunded,
      }));
  }
}

export function createCommerceMockStore(seed: CommerceMockSeed = {}): CommerceMockStore {
  return new CommerceMockStore(seed);
}
