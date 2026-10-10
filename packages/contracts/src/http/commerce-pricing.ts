import { z } from 'zod';
import { CurrencySchema, MoneyAmountSchema, MoneySchema } from '../money/money';
import { uuidListParam } from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';

/* ----------------------------------------------------------------------------------------
 * Instructor pricing (instructor BFF, `@CheckPolicy` course:read / course:update):
 *
 *   GET /courses/:courseId/pricing -> 200 CoursePricing             (404)
 *   PUT /courses/:courseId/pricing -> 200 CoursePricing             (404, 422 price_not_allowed, 429)
 *
 * Params: `CourseIdParamsSchema`. A price applies immediately, also while the course is a
 * draft or in review (D2). Rate limit: 10 changes per course per 24 h.
 * -------------------------------------------------------------------------------------- */

/** One entry of the append-only `course_price_changes` history. */
export const CoursePriceChangeSchema = z.object({
  id: UuidSchema,
  /** Null for the first price. */
  previousAmount: MoneyAmountSchema.nullable(),
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  changedBy: UuidSchema,
  changedAt: IsoDateTimeSchema,
});
export type CoursePriceChange = z.infer<typeof CoursePriceChangeSchema>;

export const COURSE_PRICING_HISTORY_LIMIT = 20;

export const CoursePricingSchema = z.object({
  courseId: UuidSchema,
  /** Null: no price yet, so the course is not for sale (D16, "Set a price"). */
  price: MoneySchema.nullable(),
  /** `price.amount === '0.00'`; false when there is no price. */
  isFree: z.boolean(),
  /** Newest first, at most `COURSE_PRICING_HISTORY_LIMIT`. */
  history: z.array(CoursePriceChangeSchema).max(COURSE_PRICING_HISTORY_LIMIT),
});
export type CoursePricing = z.infer<typeof CoursePricingSchema>;

/**
 * `{ amount }` in the platform currency; `"0.00"` makes the course free. Only the decimal
 * format is checked here: an amount that is not in `PRICE_TIERS` gets 422 `price_not_allowed`.
 * Forms can validate with `PriceTierSchema`.
 */
export const SetCoursePriceRequestSchema = z.object({ amount: MoneyAmountSchema });
export type SetCoursePriceRequest = z.output<typeof SetCoursePriceRequestSchema>;

export const SetCoursePriceResponseSchema = CoursePricingSchema;
export type SetCoursePriceResponse = CoursePricing;

/** Price changes per course per 24 h (§9). */
export const PRICE_CHANGES_PER_DAY = 10;

/* ----------------------------------------------------------------------------------------
 * GET /commerce/prices?courseIds=a,b -> 200 { items } (public, student BFF, C + @Public)
 * `Cache-Control: public, max-age=60`. Ids that are not PUBLISHED or have no price are omitted.
 * -------------------------------------------------------------------------------------- */

export const PUBLIC_PRICES_MAX_IDS = 48;
export const PUBLIC_PRICES_CACHE_CONTROL = 'public, max-age=60';

export const PublicPricesQuerySchema = z.object({
  courseIds: uuidListParam(PUBLIC_PRICES_MAX_IDS),
});
export type PublicPricesQuery = z.output<typeof PublicPricesQuerySchema>;

export const PublicPriceSchema = z.object({
  courseId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  isFree: z.boolean(),
});
export type PublicPrice = z.infer<typeof PublicPriceSchema>;

export const PublicPricesResponseSchema = z.object({ items: z.array(PublicPriceSchema) });
export type PublicPricesResponse = z.infer<typeof PublicPricesResponseSchema>;
