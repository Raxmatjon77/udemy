import { ErrorCode } from '@udemy/contracts';
import { ConflictError } from '@udemy/nest-common/errors';
import {
  CouponCodeTaken,
  CouponNotApplicable,
  InvalidCommerceField,
  PriceNotAllowed,
  RefundNotApplicable,
} from '../domain/commerce.errors';

interface PgErrorLike {
  code: string;
  constraint?: string;
}

export function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

type ToDomainError = (cause: unknown) => Error;

const field =
  (path: string, message: string): ToDomainError =>
  (cause) =>
    new InvalidCommerceField([{ path, message }], { cause });

/** 409 `invalid_state_transition` (a conditional-update race on a transition log). */
const invalidTransition: ToDomainError = (cause) =>
  new ConflictError('This action is not possible in the current state.', {
    code: ErrorCode.InvalidStateTransition,
    cause,
  });

/**
 * Constraint name -> domain error for the `commerce` tables (schema doc §9). For unique
 * indexes and trigger pseudo-constraints `err.constraint` is the name below; deferred ones
 * raise at COMMIT, so the transaction runner maps those as well.
 *
 * **Context-free entries only.** Errors whose mapping depends on the use case are mapped by
 * that use case (P4-T15/T16 add theirs there, or here when they are context-free):
 *
 * - `orders_user_id_idempotency_key_uq`: resume by key, or `idempotency_key_reused`;
 * - `orders_user_id_pending_uq`: `checkout_in_progress` with a re-read `{orderId, checkoutUrl}`;
 * - in Checkout, `coupon_redemptions_limit_ck` / `_coupon_valid_ck` / the per-user unique become
 *   409 `price_changed` with the fresh quote, instead of the 422s below;
 * - `order_lines_order_id_course_id_uq`: `cart_changed` with the quote.
 *
 * Not listed, so a 500 (programming errors, logged by the global filter):
 * `course_prices_noop_update_ck` / `_immutable_ck` (the upsert's IS DISTINCT guard prevents
 * them), `coupons_immutable_ck` (deactivate with `WHERE deactivated_at IS NULL`),
 * `cart_items_user_id_fk` (lock the cart first), `orders_total_ck`, `orders_status_log_ck`,
 * `payments_*`, `postings_balanced_ck`, `coupon_redemptions_transition_ck` and 42501 from the
 * append-only guards.
 */
export const COMMERCE_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // Pricing (the PriceTier VO validates first; a hit is a validation gap: still 422)
  course_prices_amount_ck: (cause) => new PriceNotAllowed({ cause }),
  course_prices_currency_ck: (cause) => new PriceNotAllowed({ cause }),
  // Coupons: one code per course / among platform coupons, never reused (D5)
  coupons_course_id_code_uq: (cause) => new CouponCodeTaken({ cause }),
  // Coupon terms (CreateCourseCoupon / CreatePlatformCoupon validate first)
  coupons_window_ck: field('endsAt', 'Invalid coupon validity window.'),
  coupons_percent_off_ck: field('percentOff', 'Must be an integer from 1 to 100.'),
  coupons_amount_off_ck: field('amountOff', 'Must be greater than 0.00.'),
  coupons_max_redemptions_ck: field('maxRedemptions', 'Must be from 1 to 100000.'),
  coupons_code_ck: field('code', '4–20 letters, digits, "_" or "-".'),
  coupons_platform_type_ck: field('discountType', 'Platform coupons are PERCENT only.'),
  coupons_discount_shape_ck: field('discountType', 'Invalid discount.'),
  // The cart's code (ApplyCoupon normalises first)
  carts_coupon_code_ck: (cause) => new CouponNotApplicable(ErrorCode.CouponInvalid, { cause }),
  // Redemptions outside Checkout (Checkout maps these to price_changed, see above)
  coupon_redemptions_coupon_id_user_id_active_uq: (cause) =>
    new CouponNotApplicable(ErrorCode.CouponAlreadyUsed, { cause }),
  coupon_redemptions_limit_ck: (cause) =>
    new CouponNotApplicable(ErrorCode.CouponExhausted, { cause }),
  // Transition logs: a conditional-update race (impossible under the row locks; logged)
  order_transitions_pk: invalidTransition,
  refund_transitions_pk: invalidTransition,
  order_transitions_edge_ck: invalidTransition,
  refund_transitions_edge_ck: invalidTransition,
  order_transitions_order_id_prev_seq_from_status_fk: invalidTransition,
  refund_transitions_refund_id_prev_seq_from_status_fk: invalidTransition,
  // Admin money actions need a reason (the request schemas check them first)
  order_transitions_reason_ck: field('reason', 'A reason of 10–2000 characters is required.'),
  refund_transitions_reason_ck: field('reason', 'A reason of 10–2000 characters is required.'),
  // Refunds (context-free parts)
  refunds_order_line_id_live_uq: (cause) =>
    new ConflictError('A refund for this course is already in progress.', {
      code: ErrorCode.RefundAlreadyRequested,
      cause,
    }),
  refunds_reason_code_ck: field('reasonCode', 'Invalid reason.'),
  // The order left PAID / PARTIALLY_REFUNDED under a race (the use cases check first)
  refunds_order_status_ck: (cause) =>
    new RefundNotApplicable('This order can no longer be refunded.', { cause }),
  refunds_comment_ck: field('comment', 'At most 1000 characters.'),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowCommerceConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = COMMERCE_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapCommerceConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowCommerceConstraint(error);
  }
}
