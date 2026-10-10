import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { CurrencySchema, MoneyAmountSchema } from '../money/money';
import { PersonRefSchema } from './catalog';
import {
  CouponCodeSchema,
  CouponProblemCodeSchema,
  PurchaseBlockReasonSchema,
  uuidListParam,
} from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';

/* ----------------------------------------------------------------------------------------
 * Server cart (signed-in students only, D4; P `cart:manage`):
 *
 *   GET    /me/cart                    -> 200 CartQuote
 *   PUT    /me/cart/items/:courseId    -> 200 CartQuote   (404 course_not_found, 409
 *          course_not_for_sale | course_is_free | cannot_purchase_own_course | already_enrolled,
 *          422 cart_full, 429). Adding twice is a 200.
 *   DELETE /me/cart/items/:courseId    -> 200 CartQuote   (idempotent)
 *   POST   /me/cart/merge              -> 200 MergeGuestCartResponse (422 cart_full)
 *   PUT    /me/cart/coupon             -> 200 CartQuote   (422 coupon_*, 429)
 *   DELETE /me/cart/coupon             -> 200 CartQuote
 *
 * Item params: `CartItemParamsSchema` (= `CourseIdParamsSchema`). Prices in a quote are always
 * recomputed by the server; no request ever carries a price (§9).
 * -------------------------------------------------------------------------------------- */

export const CART_LIMITS = Object.freeze({
  /** `COMMERCE_CART_MAX_ITEMS` default. */
  maxItems: 20,
  /** One coupon code per cart (D4). */
  maxCouponCodes: 1,
});

export const CartItemParamsSchema = z.object({ courseId: UuidSchema });
export type CartItemParams = z.output<typeof CartItemParamsSchema>;

/** A purchasable cart line with its current price and the best coupon for it (D5). */
export const CartLineSchema = z.object({
  courseId: UuidSchema,
  slug: z.string(),
  title: z.string(),
  /** Null when the instructor is banned or unknown. */
  instructor: PersonRefSchema.nullable(),
  hasThumbnail: z.boolean(),
  listAmount: MoneyAmountSchema,
  /** 0.00 when no coupon applies to this line. */
  discountAmount: MoneyAmountSchema,
  finalAmount: MoneyAmountSchema,
  /** The coupon that won for this line (course coupon on a tie, D5); null when none. */
  couponId: UuidSchema.nullable(),
  addedAt: IsoDateTimeSchema,
});
export type CartLine = z.infer<typeof CartLineSchema>;

/** A cart item that cannot be bought right now; it stays in the cart until removed. */
export const CartUnavailableLineSchema = z.object({
  courseId: UuidSchema,
  /** Null when the course no longer exists. */
  title: z.string().nullable(),
  reason: PurchaseBlockReasonSchema,
  addedAt: IsoDateTimeSchema,
});
export type CartUnavailableLine = z.infer<typeof CartUnavailableLineSchema>;

/**
 * The cart's coupon code. A code that no longer applies is reported (`applied: false` plus
 * the `problem` code), not silently dropped.
 */
export const CartCouponSchema = z.object({
  code: z.string(),
  applied: z.boolean(),
  /** Null when applied. */
  problem: CouponProblemCodeSchema.nullable(),
});
export type CartCoupon = z.infer<typeof CartCouponSchema>;

export const CartTotalsSchema = z.object({
  listAmount: MoneyAmountSchema,
  discountAmount: MoneyAmountSchema,
  /** What checkout charges; send it back as `expectedTotal`. */
  totalAmount: MoneyAmountSchema,
});
export type CartTotals = z.infer<typeof CartTotalsSchema>;

/** `GetCart` = the quote (§5). */
export const CartQuoteSchema = z.object({
  currency: CurrencySchema,
  lines: z.array(CartLineSchema).max(CART_LIMITS.maxItems),
  unavailable: z.array(CartUnavailableLineSchema).max(CART_LIMITS.maxItems),
  coupon: CartCouponSchema.nullable(),
  totals: CartTotalsSchema,
  /** Purchasable plus unavailable items. */
  itemCount: z.number().int().min(0).max(CART_LIMITS.maxItems),
  /** SHA-256 (lowercase hex) of the sorted `courseId:final` pairs, coupon id and currency. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CartQuote = z.infer<typeof CartQuoteSchema>;

/* POST /me/cart/merge: the guest (`localStorage`) cart after login, best effort (D4). */

export const MergeGuestCartRequestSchema = z.object({
  courseIds: z
    .array(UuidSchema)
    .min(1)
    .max(CART_LIMITS.maxItems)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
});
export type MergeGuestCartRequest = z.output<typeof MergeGuestCartRequestSchema>;

/** A guest-cart id that was not added; `cart_full` when the cart ran out of room. */
export const MergeSkipReasonSchema = z.enum([
  ...PurchaseBlockReasonSchema.options,
  ErrorCode.CartFull,
]);
export type MergeSkipReason = z.infer<typeof MergeSkipReasonSchema>;

export const MergeGuestCartResponseSchema = z.object({
  quote: CartQuoteSchema,
  /** Newly added ids (already present ones are neither added nor skipped). */
  added: z.array(UuidSchema),
  skipped: z.array(z.object({ courseId: UuidSchema, reason: MergeSkipReasonSchema })),
});
export type MergeGuestCartResponse = z.infer<typeof MergeGuestCartResponseSchema>;

/* PUT /me/cart/coupon (rate-limited 20/h per user, 60/h per IP; every apply counts). */

export const ApplyCouponRequestSchema = z.object({ code: CouponCodeSchema });
export type ApplyCouponRequest = z.output<typeof ApplyCouponRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /me/purchase-states?courseIds=a,b -> 200 { items } (P `enrollment:read:own`, 400)
 * One item per requested id, for the landing `PurchaseBox` and course cards.
 * -------------------------------------------------------------------------------------- */

export const PURCHASE_STATES_MAX_IDS = 48;

export const PurchaseStatesQuerySchema = z.object({
  courseIds: uuidListParam(PURCHASE_STATES_MAX_IDS),
});
export type PurchaseStatesQuery = z.output<typeof PurchaseStatesQuerySchema>;

export const PurchaseStateSchema = z.object({
  courseId: UuidSchema,
  /** ACTIVE enrollment ("Go to course"). */
  enrolled: z.boolean(),
  inCart: z.boolean(),
  /** The viewer is the instructor ("You're the instructor"). */
  isOwner: z.boolean(),
});
export type PurchaseState = z.infer<typeof PurchaseStateSchema>;

export const PurchaseStatesResponseSchema = z.object({ items: z.array(PurchaseStateSchema) });
export type PurchaseStatesResponse = z.infer<typeof PurchaseStatesResponseSchema>;
