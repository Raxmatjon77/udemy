import {
  CancelOrderResponseSchema,
  CartQuoteSchema,
  CheckoutResponseSchema,
  FreeEnrollmentResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  LearningCardPageSchema,
  MergeGuestCartResponseSchema,
  OrderDetailSchema,
  OrderSummaryPageSchema,
  PublicPricesResponseSchema,
  PurchaseStatesResponseSchema,
  ReceiptSchema,
  RequestRefundResponseSchema,
  type CartQuote,
  type CheckoutResponse,
  type Enrollment,
  type LearningCardPage,
  type MergeGuestCartResponse,
  type OrderDetail,
  type OrderSummaryPage,
  type PublicPrice,
  type PurchaseState,
  type Receipt,
  type Refund,
  type RequestRefundRequest,
} from '@udemy/contracts';

import { api, queryString } from '../api';

/**
 * Browser calls of the Phase 4 commerce & enrollment routes (design §8), through this app's BFF
 * (`/api/proxy/*`). Every response is parsed with its contracts schema; a mismatch surfaces as a
 * generic 502 `ProxyFetchError`. Prices are never sent: the server always recomputes (§9).
 */

const id = (value: string) => encodeURIComponent(value);

/** TanStack Query keys of the commerce screens (invalidate by prefix). */
export const commerceKeys = {
  cart: ['me', 'cart'] as const,
  purchaseStatesAll: ['me', 'purchase-states'] as const,
  purchaseStates: (courseIds: readonly string[]) =>
    ['me', 'purchase-states', [...courseIds].sort()] as const,
  prices: (courseIds: readonly string[]) => ['commerce', 'prices', [...courseIds].sort()] as const,
  ordersAll: ['me', 'orders'] as const,
  orders: ['me', 'orders', 'list'] as const,
  order: (orderId: string) => ['me', 'orders', 'detail', orderId] as const,
  receipt: (orderId: string) => ['me', 'orders', 'receipt', orderId] as const,
  myLearning: ['me', 'enrollments'] as const,
};

/* ------------------------------------------------------------------ public */

/** `GET /commerce/prices?courseIds=` (public; ids without a price are omitted). */
export async function fetchPublicPrices(
  courseIds: readonly string[],
  signal?: AbortSignal,
): Promise<PublicPrice[]> {
  if (courseIds.length === 0) return [];
  const response = await api(`/commerce/prices${queryString({ courseIds: courseIds.join(',') })}`, {
    schema: PublicPricesResponseSchema,
    quiet: true,
    ...(signal ? { signal } : {}),
  });
  return response.items;
}

/* ------------------------------------------------------------------ cart */

export function fetchCart(signal?: AbortSignal): Promise<CartQuote> {
  return api('/me/cart', { schema: CartQuoteSchema, quiet: true, ...(signal ? { signal } : {}) });
}

export function addToCart(courseId: string): Promise<CartQuote> {
  return api(`/me/cart/items/${id(courseId)}`, { method: 'PUT', schema: CartQuoteSchema });
}

export function removeFromCart(courseId: string): Promise<CartQuote> {
  return api(`/me/cart/items/${id(courseId)}`, { method: 'DELETE', schema: CartQuoteSchema });
}

export function mergeGuestCart(courseIds: readonly string[]): Promise<MergeGuestCartResponse> {
  return api('/me/cart/merge', {
    method: 'POST',
    json: { courseIds },
    schema: MergeGuestCartResponseSchema,
    quiet: true,
  });
}

export function applyCoupon(code: string): Promise<CartQuote> {
  return api('/me/cart/coupon', { method: 'PUT', json: { code }, schema: CartQuoteSchema });
}

export function removeCoupon(): Promise<CartQuote> {
  return api('/me/cart/coupon', { method: 'DELETE', schema: CartQuoteSchema });
}

export async function fetchPurchaseStates(
  courseIds: readonly string[],
  signal?: AbortSignal,
): Promise<PurchaseState[]> {
  const response = await api(
    `/me/purchase-states${queryString({ courseIds: courseIds.join(',') })}`,
    { schema: PurchaseStatesResponseSchema, quiet: true, ...(signal ? { signal } : {}) },
  );
  return response.items;
}

/* ------------------------------------------------------------------ checkout and orders */

/** `POST /me/checkout` with the attempt's `Idempotency-Key` (§5 Checkout). */
export function checkout(idempotencyKey: string, expectedTotal: string): Promise<CheckoutResponse> {
  return api('/me/checkout', {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    json: { expectedTotal },
    schema: CheckoutResponseSchema,
  });
}

export function fetchOrders(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<OrderSummaryPage> {
  return api(`/me/orders${queryString({ cursor })}`, {
    schema: OrderSummaryPageSchema,
    ...(signal ? { signal } : {}),
  });
}

export function fetchOrder(orderId: string, signal?: AbortSignal): Promise<OrderDetail> {
  return api(`/me/orders/${id(orderId)}`, {
    schema: OrderDetailSchema,
    ...(signal ? { signal } : {}),
  });
}

export function fetchReceipt(orderId: string, signal?: AbortSignal): Promise<Receipt> {
  return api(`/me/orders/${id(orderId)}/receipt`, {
    schema: ReceiptSchema,
    ...(signal ? { signal } : {}),
  });
}

/** `POST /me/orders/:id/cancel`: idempotent; releases the coupon and unblocks a new checkout. */
export function cancelOrder(orderId: string): Promise<OrderDetail> {
  return api(`/me/orders/${id(orderId)}/cancel`, {
    method: 'POST',
    schema: CancelOrderResponseSchema,
  });
}

export function requestRefund(orderId: string, body: RequestRefundRequest): Promise<Refund> {
  return api(`/me/orders/${id(orderId)}/refunds`, {
    method: 'POST',
    json: body,
    schema: RequestRefundResponseSchema,
  });
}

/* ------------------------------------------------------------------ enrollment */

export function enrollFree(courseId: string): Promise<Enrollment> {
  return api('/me/free-enrollments', {
    method: 'POST',
    json: { courseId },
    schema: FreeEnrollmentResponseSchema,
  });
}

export function fetchMyLearning(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<LearningCardPage> {
  return api(`/me/enrollments${queryString({ cursor })}`, {
    schema: LearningCardPageSchema,
    ...(signal ? { signal } : {}),
  });
}
