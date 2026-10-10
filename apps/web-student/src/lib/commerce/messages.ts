import {
  ErrorCode,
  formatMoney,
  MIN_CHARGE_AMOUNT,
  DEFAULT_CURRENCY,
  type MergeSkipReason,
  type RefundBlockReason,
} from '@udemy/contracts';

import type { MessageOverrides } from '../problem';
import { formatWait } from '../problem';

/**
 * User-facing wording for the commerce problem codes (design §5 "New error codes"). The UI
 * branches on the stable `code` only; these are passed to `problemMessage(error, overrides)`.
 */

const minCharge = formatMoney(MIN_CHARGE_AMOUNT, DEFAULT_CURRENCY, 'en-US');

/** Why a course cannot go into the cart (the `PurchaseBlockReason` codes, 404/409). */
export const PURCHASE_MESSAGES: MessageOverrides = {
  [ErrorCode.CourseNotFound]: 'This course is no longer available.',
  [ErrorCode.CourseNotForSale]: 'This course is not available for purchase yet.',
  [ErrorCode.CourseIsFree]: 'This course is free: enroll directly instead.',
  [ErrorCode.CourseNotFree]: 'This course is not free anymore. Add it to your cart instead.',
  [ErrorCode.CannotPurchaseOwnCourse]: 'You are the instructor of this course.',
  [ErrorCode.AlreadyEnrolled]: 'You are already enrolled in this course.',
  [ErrorCode.CartFull]: 'Your cart is full. Remove a course before adding another.',
};

/** Short reasons for the cart's unavailable lines and the guest-cart merge notice. */
export const PURCHASE_BLOCK_SHORT: Readonly<Record<MergeSkipReason, string>> = {
  [ErrorCode.CourseNotFound]: 'no longer available',
  [ErrorCode.CourseNotForSale]: 'not for sale',
  [ErrorCode.CourseIsFree]: 'free, enroll from its page',
  [ErrorCode.CannotPurchaseOwnCourse]: 'your own course',
  [ErrorCode.AlreadyEnrolled]: 'already enrolled',
  [ErrorCode.CartFull]: 'cart is full',
};

/** `PUT /me/cart/coupon` (422 `coupon_*`, 429) and the quote's `coupon.problem`. */
export const COUPON_MESSAGES: MessageOverrides = {
  [ErrorCode.CouponInvalid]: 'This code is not valid for the courses in your cart.',
  [ErrorCode.CouponExpired]: 'This code has expired.',
  [ErrorCode.CouponNotStarted]: 'This code is not active yet.',
  [ErrorCode.CouponExhausted]: 'This code has been used up.',
  [ErrorCode.CouponAlreadyUsed]: 'You have already used this code.',
  [ErrorCode.RateLimited]: (error) =>
    `Too many code attempts. Try again ${
      error.retryAfterSeconds === null ? 'later' : formatWait(error.retryAfterSeconds)
    }.`,
};

/** `POST /me/checkout`. The 409s with a payload are handled by the cart itself. */
export const CHECKOUT_MESSAGES: MessageOverrides = {
  [ErrorCode.CartEmpty]: 'Your cart is empty.',
  [ErrorCode.AmountBelowMinimum]: `Card payments must be at least ${minCharge}. Add another course or remove the code to continue.`,
  [ErrorCode.PaymentProviderUnavailable]:
    'The payment service is not responding right now. Please try again in a moment.',
  [ErrorCode.IdempotencyKeyReused]: 'Your cart changed while checking out. Please try again.',
  [ErrorCode.EmailNotVerified]: 'Verify your email address before paying for a course.',
  [ErrorCode.OrderNotCancelable]:
    'That payment has already gone through. Check your orders in a moment.',
  [ErrorCode.CheckoutInProgress]: 'You already have a checkout in progress.',
};

/** Why a line cannot be refunded (`OrderLineRefundState.reason`, and the 409/422 answers). */
export const REFUND_BLOCK_MESSAGES: Readonly<Record<RefundBlockReason, string>> = {
  [ErrorCode.RefundWindowClosed]: 'The refund window for this course has closed.',
  [ErrorCode.RefundNotApplicable]: 'This purchase cannot be refunded.',
  [ErrorCode.RefundAlreadyRequested]: 'A refund has already been requested for this course.',
};

export const REFUND_MESSAGES: MessageOverrides = {
  ...REFUND_BLOCK_MESSAGES,
  [ErrorCode.OrderNotFound]: 'We could not find this purchase.',
  [ErrorCode.RateLimited]: (error) =>
    `You have made several refund requests today. Try again ${
      error.retryAfterSeconds === null ? 'tomorrow' : formatWait(error.retryAfterSeconds)
    }.`,
};
