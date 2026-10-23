import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import type { z } from 'zod';
import { ErrorCode } from '../errors/error-code.js';
import { CourseIdParamsSchema } from '../http/catalog.js';
import {
  AcceptPaymentRequestSchema,
  AcceptPaymentResponseSchema,
  AdminOrderDetailSchema,
  AdminOrderPageSchema,
  AdminOrdersQuerySchema,
  AdminRefundOrderLinesRequestSchema,
  AdminRefundOrderLinesResponseSchema,
  AdminRefundQueuePageSchema,
  AdminRefundsQuerySchema,
  ApproveRefundRequestSchema,
  RefundDecisionResponseSchema,
  RefundIdParamsSchema,
  RejectRefundRequestSchema,
  RetryRefundRequestSchema,
} from '../http/commerce-admin.js';
import {
  ApplyCouponRequestSchema,
  CartItemParamsSchema,
  CartQuoteSchema,
  MergeGuestCartRequestSchema,
  MergeGuestCartResponseSchema,
  PurchaseStatesQuerySchema,
  PurchaseStatesResponseSchema,
} from '../http/commerce-cart.js';
import {
  CouponIdParamsSchema,
  CouponPageSchema,
  CouponSchema,
  CouponsQuerySchema,
  CourseCouponParamsSchema,
  CreateCourseCouponRequestSchema,
  CreatePlatformCouponRequestSchema,
} from '../http/commerce-coupons.js';
import {
  CancelOrderResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  MyOrdersQuerySchema,
  OrderDetailSchema,
  OrderIdParamsSchema,
  OrderSummaryPageSchema,
  ReceiptSchema,
  RequestRefundRequestSchema,
  RequestRefundResponseSchema,
} from '../http/commerce-orders.js';
import {
  CoursePricingSchema,
  PUBLIC_PRICES_CACHE_CONTROL,
  PublicPricesQuerySchema,
  PublicPricesResponseSchema,
  SetCoursePriceRequestSchema,
} from '../http/commerce-pricing.js';
import {
  RecentSalePageSchema,
  RecentSalesQuerySchema,
  SalesSummaryQuerySchema,
  SalesSummarySchema,
} from '../http/commerce-sales.js';
import {
  AdminEnrollmentResponseSchema,
  AdminGrantEnrollmentRequestSchema,
  AdminRevokeEnrollmentRequestSchema,
  AdminUserEnrollmentsSchema,
  EnrollmentIdParamsSchema,
  FreeEnrollmentRequestSchema,
  FreeEnrollmentResponseSchema,
  LearningCardPageSchema,
  MyLearningQuerySchema,
} from '../http/enrollment.js';
import { UserIdParamsSchema } from '../http/me.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../http/problem-details.js';
import { makeProblem } from './fixtures.mjs';
import { type CommerceMockStore, createCommerceMockStore, MockApiError } from './mock-store.mjs';

export interface CommerceHandlersOptions {
  /**
   * Prefix of every route, without a trailing slash. Browser code behind the BFF uses
   * `'*\/api/proxy'`; server code calling the api uses e.g. `'http://api.test/api/v1'`.
   */
  baseUrl: string;
  /** Shared state; a fresh default store when omitted (read it back via the return value). */
  store?: CommerceMockStore;
}

export interface CommerceHandlers {
  handlers: HttpHandler[];
  store: CommerceMockStore;
}

/** An RFC 7807 response like the api sends (`application/problem+json`). */
export function problemResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(makeProblem(status, code, extra)), {
    status,
    headers: { ...headers, 'content-type': PROBLEM_JSON_CONTENT_TYPE },
  });
}

/** The mock's opaque keyset cursor: the offset of the next item (`o20`), like-shaped to the api's. */
const CURSOR_PATTERN = /^o(\d{1,9})$/;

/**
 * One page of `items` like the api's keyset pages: `limit` items, and a `nextCursor` only when
 * more items follow. A cursor the mock did not issue is 422 `validation_failed` (the api
 * rejects a cursor it cannot decode the same way).
 */
function paginate<T>(
  items: readonly T[],
  query: { cursor?: string | undefined; limit: number },
): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (query.cursor !== undefined) {
    const match = CURSOR_PATTERN.exec(query.cursor);
    if (!match) {
      throw new MockApiError(422, ErrorCode.ValidationFailed, {
        errors: [{ path: 'cursor', message: 'Invalid cursor' }],
      });
    }
    start = Number(match[1]);
  }
  const end = start + query.limit;
  return { items: items.slice(start, end), nextCursor: end < items.length ? `o${end}` : null };
}

class BadRequest extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super('validation_failed');
  }
}

function check<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequest(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** `?a=1&a=2` → `{ a: ['1','2'] }`, `?a=1` → `{ a: '1' }`. */
function queryOf(request: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const previous = out[key];
    out[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return out;
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest([{ path: '', message: 'Malformed JSON' }]);
  }
}

/** Parses the outgoing body with its contract (a drift throws inside the test). */
function reply<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return HttpResponse.json(schema.parse(body) as JsonBodyType, init);
}

type Resolver = (args: {
  request: Request;
  params: Record<string, string | readonly string[] | undefined>;
}) => Response | Promise<Response>;

/** Maps store errors and bad input to problem responses. */
function guarded(resolve: Resolver): Resolver {
  return async (args) => {
    try {
      return await resolve(args);
    } catch (error) {
      if (error instanceof MockApiError) {
        return problemResponse(error.status, error.code, error.extra, error.headers);
      }
      if (error instanceof BadRequest) {
        return problemResponse(400, ErrorCode.ValidationFailed, { errors: error.errors });
      }
      throw error;
    }
  };
}

/**
 * MSW handlers for every Phase 4 route of design §8 that goes through a BFF (the Stripe
 * webhook does not; drive payments with `store.completePayment(orderId)` /
 * `store.expirePayment(orderId)` and refunds with `store.settleRefund(refundId, …)`).
 *
 * ```ts
 * const { handlers, store } = createCommerceHandlers({ baseUrl: '*\/api/proxy' });
 * const server = setupServer(...handlers); // msw/node in vitest, or setupWorker in the browser
 * ```
 *
 * Requests are validated with the contracts request schemas (400 `validation_failed`), and
 * every response body is parsed with its response schema before it is sent.
 */
export function createCommerceHandlers(options: CommerceHandlersOptions): CommerceHandlers {
  const store = options.store ?? createCommerceMockStore();
  const url = (path: string) => `${options.baseUrl}${path}`;

  const route = (
    method: 'get' | 'put' | 'post' | 'delete',
    path: string,
    resolve: Resolver,
  ): HttpHandler => http[method](url(path), guarded(resolve));

  const handlers: HttpHandler[] = [
    /* ------------------------------------------------------------ public */
    route('get', '/commerce/prices', ({ request }) => {
      const { courseIds } = check(PublicPricesQuerySchema, queryOf(request));
      return reply(
        PublicPricesResponseSchema,
        { items: store.publicPrices(courseIds) },
        { headers: { 'cache-control': PUBLIC_PRICES_CACHE_CONTROL } },
      );
    }),

    /* ------------------------------------------------------------ cart */
    route('get', '/me/cart', () => reply(CartQuoteSchema, store.quote())),
    route('put', '/me/cart/items/:courseId', ({ params }) => {
      const { courseId } = check(CartItemParamsSchema, params);
      return reply(CartQuoteSchema, store.addToCart(courseId));
    }),
    route('delete', '/me/cart/items/:courseId', ({ params }) => {
      const { courseId } = check(CartItemParamsSchema, params);
      return reply(CartQuoteSchema, store.removeFromCart(courseId));
    }),
    route('post', '/me/cart/merge', async ({ request }) => {
      const { courseIds } = check(MergeGuestCartRequestSchema, await bodyOf(request));
      return reply(MergeGuestCartResponseSchema, store.mergeGuestCart(courseIds));
    }),
    route('put', '/me/cart/coupon', async ({ request }) => {
      const { code } = check(ApplyCouponRequestSchema, await bodyOf(request));
      return reply(CartQuoteSchema, store.applyCoupon(code));
    }),
    route('delete', '/me/cart/coupon', () => reply(CartQuoteSchema, store.removeCoupon())),
    route('get', '/me/purchase-states', ({ request }) => {
      const { courseIds } = check(PurchaseStatesQuerySchema, queryOf(request));
      return reply(PurchaseStatesResponseSchema, { items: store.purchaseStates(courseIds) });
    }),

    /* ------------------------------------------------------------ checkout and orders */
    route('post', '/me/checkout', async ({ request }) => {
      const header = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      const key = header === null || header === '' ? null : check(IdempotencyKeySchema, header);
      const { expectedTotal } = check(CheckoutRequestSchema, await bodyOf(request));
      return reply(CheckoutResponseSchema, store.checkout(key, expectedTotal), { status: 201 });
    }),
    route('get', '/me/orders', ({ request }) => {
      const query = check(MyOrdersQuerySchema, queryOf(request));
      return reply(OrderSummaryPageSchema, paginate(store.myOrders(), query));
    }),
    route('get', '/me/orders/:orderId', ({ params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      return reply(OrderDetailSchema, store.myOrder(orderId));
    }),
    route('get', '/me/orders/:orderId/receipt', ({ params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      return reply(ReceiptSchema, store.receipt(orderId));
    }),
    route('post', '/me/orders/:orderId/cancel', ({ params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      return reply(CancelOrderResponseSchema, store.cancelOrder(orderId));
    }),
    route('post', '/me/orders/:orderId/refunds', async ({ request, params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      const body = check(RequestRefundRequestSchema, await bodyOf(request));
      return reply(RequestRefundResponseSchema, store.requestRefund(orderId, body), {
        status: 201,
      });
    }),

    /* ------------------------------------------------------------ enrollment */
    route('post', '/me/free-enrollments', async ({ request }) => {
      const { courseId } = check(FreeEnrollmentRequestSchema, await bodyOf(request));
      const { status, enrollment } = store.enrollFree(courseId);
      return reply(FreeEnrollmentResponseSchema, enrollment, { status });
    }),
    route('get', '/me/enrollments', ({ request }) => {
      const query = check(MyLearningQuerySchema, queryOf(request));
      return reply(LearningCardPageSchema, paginate(store.myLearning(), query));
    }),

    /* ------------------------------------------------------------ instructor */
    route('get', '/courses/:courseId/pricing', ({ params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      return reply(CoursePricingSchema, store.coursePricing(courseId));
    }),
    route('put', '/courses/:courseId/pricing', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const { amount } = check(SetCoursePriceRequestSchema, await bodyOf(request));
      return reply(CoursePricingSchema, store.setCoursePrice(courseId, amount));
    }),
    route('get', '/courses/:courseId/coupons', ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const query = check(CouponsQuerySchema, queryOf(request));
      return reply(CouponPageSchema, paginate(store.listCoupons(courseId), query));
    }),
    route('post', '/courses/:courseId/coupons', async ({ request, params }) => {
      const { courseId } = check(CourseIdParamsSchema, params);
      const body = check(CreateCourseCouponRequestSchema, await bodyOf(request));
      return reply(CouponSchema, store.createCoupon(courseId, body), { status: 201 });
    }),
    route('post', '/courses/:courseId/coupons/:couponId/deactivate', ({ params }) => {
      const { courseId, couponId } = check(CourseCouponParamsSchema, params);
      return reply(CouponSchema, store.deactivateCoupon(courseId, couponId));
    }),
    route('get', '/instructor/sales/summary', ({ request }) => {
      const { from, to } = check(SalesSummaryQuerySchema, queryOf(request));
      return reply(SalesSummarySchema, store.salesSummary(from, to));
    }),
    route('get', '/instructor/sales', ({ request }) => {
      const query = check(RecentSalesQuerySchema, queryOf(request));
      return reply(RecentSalePageSchema, paginate(store.recentSales(query.courseId), query));
    }),

    /* ------------------------------------------------------------ admin */
    route('get', '/admin/orders', ({ request }) => {
      const query = check(AdminOrdersQuerySchema, queryOf(request));
      return reply(AdminOrderPageSchema, paginate(store.adminOrders(query), query));
    }),
    route('get', '/admin/orders/:orderId', ({ params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      return reply(AdminOrderDetailSchema, store.adminOrder(orderId));
    }),
    route('post', '/admin/orders/:orderId/refunds', async ({ request, params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      const body = check(AdminRefundOrderLinesRequestSchema, await bodyOf(request));
      return reply(
        AdminRefundOrderLinesResponseSchema,
        store.adminRefundLines(orderId, body.orderLineIds, body.reason),
        { status: 201 },
      );
    }),
    route('post', '/admin/orders/:orderId/accept-payment', async ({ request, params }) => {
      const { orderId } = check(OrderIdParamsSchema, params);
      const { reason } = check(AcceptPaymentRequestSchema, await bodyOf(request));
      return reply(AcceptPaymentResponseSchema, store.acceptPayment(orderId, reason));
    }),
    route('get', '/admin/refunds', ({ request }) => {
      const query = check(AdminRefundsQuerySchema, queryOf(request));
      return reply(AdminRefundQueuePageSchema, paginate(store.refundQueue(query.status), query));
    }),
    route('post', '/admin/refunds/:refundId/approve', async ({ request, params }) => {
      const { refundId } = check(RefundIdParamsSchema, params);
      const { reason } = check(ApproveRefundRequestSchema, await bodyOf(request));
      return reply(RefundDecisionResponseSchema, store.decideRefund(refundId, 'approve', reason));
    }),
    route('post', '/admin/refunds/:refundId/reject', async ({ request, params }) => {
      const { refundId } = check(RefundIdParamsSchema, params);
      const { reason } = check(RejectRefundRequestSchema, await bodyOf(request));
      return reply(RefundDecisionResponseSchema, store.decideRefund(refundId, 'reject', reason));
    }),
    route('post', '/admin/refunds/:refundId/retry', async ({ request, params }) => {
      const { refundId } = check(RefundIdParamsSchema, params);
      const { reason } = check(RetryRefundRequestSchema, await bodyOf(request));
      return reply(RefundDecisionResponseSchema, store.decideRefund(refundId, 'retry', reason));
    }),
    route('get', '/admin/coupons', ({ request }) => {
      const query = check(CouponsQuerySchema, queryOf(request));
      return reply(CouponPageSchema, paginate(store.listCoupons(null), query));
    }),
    route('post', '/admin/coupons', async ({ request }) => {
      const body = check(CreatePlatformCouponRequestSchema, await bodyOf(request));
      return reply(CouponSchema, store.createCoupon(null, body), { status: 201 });
    }),
    route('post', '/admin/coupons/:couponId/deactivate', ({ params }) => {
      const { couponId } = check(CouponIdParamsSchema, params);
      return reply(CouponSchema, store.deactivateCoupon(null, couponId));
    }),
    route('get', '/admin/users/:userId/enrollments', ({ params }) => {
      const { userId } = check(UserIdParamsSchema, params);
      return reply(AdminUserEnrollmentsSchema, { items: store.userEnrollments(userId) });
    }),
    route('post', '/admin/enrollments', async ({ request }) => {
      const body = check(AdminGrantEnrollmentRequestSchema, await bodyOf(request));
      return reply(
        AdminEnrollmentResponseSchema,
        store.adminGrant(body.userId, body.courseId, body.reason),
        { status: 201 },
      );
    }),
    route('post', '/admin/enrollments/:enrollmentId/revoke', async ({ request, params }) => {
      const { enrollmentId } = check(EnrollmentIdParamsSchema, params);
      const { reason } = check(AdminRevokeEnrollmentRequestSchema, await bodyOf(request));
      return reply(AdminEnrollmentResponseSchema, store.adminRevoke(enrollmentId, reason));
    }),
  ];

  return { handlers, store };
}
