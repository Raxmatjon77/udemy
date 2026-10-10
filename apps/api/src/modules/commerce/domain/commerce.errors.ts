import {
  type CartQuote,
  type CouponProblemCode,
  ErrorCode,
  type PurchaseBlockReason,
} from '@udemy/contracts';
import {
  ConflictError,
  type DomainFieldIssue,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/*
 * Commerce domain errors (design §5 "New error codes"). The global filter renders them as
 * RFC 7807 problems: NotFoundError 404, ConflictError 409, ValidationError 422.
 */

/* ----------------------------------------------------------------------------------------
 * Pricing
 * -------------------------------------------------------------------------------------- */

/** 422 `price_not_allowed`: not one of the `PRICE_TIERS` of the platform currency (D2). */
export class PriceNotAllowed extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('This price is not one of the allowed price tiers.', {
      code: ErrorCode.PriceNotAllowed,
      issues: [{ path: 'amount', message: 'Not an allowed price tier.' }],
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Purchase eligibility (design §4: the checks in order, each with its error)
 * -------------------------------------------------------------------------------------- */

/** 404 `course_not_found`: unknown, never published or deleted. */
export class CommerceCourseNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course does not exist.', { code: ErrorCode.CourseNotFound, cause: options.cause });
  }
}

/** 409 `course_not_for_sale`: not PUBLISHED (e.g. archived), or no price yet (D16). */
export class CourseNotForSale extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This course is not available for purchase.', {
      code: ErrorCode.CourseNotForSale,
      cause: options.cause,
    });
  }
}

/** 409 `course_is_free`: enrol through `POST /me/free-enrollments` instead. */
export class CourseIsFree extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This course is free; enroll for free instead.', {
      code: ErrorCode.CourseIsFree,
      cause: options.cause,
    });
  }
}

/** 409 `cannot_purchase_own_course`. */
export class CannotPurchaseOwnCourse extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('You cannot buy your own course.', {
      code: ErrorCode.CannotPurchaseOwnCourse,
      cause: options.cause,
    });
  }
}

/** 409 `already_enrolled`: the user has an ACTIVE enrollment. */
export class AlreadyEnrolled extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('You are already enrolled in this course.', {
      code: ErrorCode.AlreadyEnrolled,
      cause: options.cause,
    });
  }
}

/** The error of a purchase block reason (AddToCart; checkout reports them in the quote). */
export function purchaseBlockedError(reason: PurchaseBlockReason): Error {
  switch (reason) {
    case ErrorCode.CourseNotFound:
      return new CommerceCourseNotFound();
    case ErrorCode.CourseNotForSale:
      return new CourseNotForSale();
    case ErrorCode.CourseIsFree:
      return new CourseIsFree();
    case ErrorCode.CannotPurchaseOwnCourse:
      return new CannotPurchaseOwnCourse();
    case ErrorCode.AlreadyEnrolled:
      return new AlreadyEnrolled();
  }
}

/* ----------------------------------------------------------------------------------------
 * Cart
 * -------------------------------------------------------------------------------------- */

/** 422 `cart_full`: at most `COMMERCE_CART_MAX_ITEMS` (20) items (D4). */
export class CartFull extends ValidationError {
  constructor(maxItems: number, options: CauseOption = {}) {
    super(`A cart holds at most ${maxItems} courses.`, {
      code: ErrorCode.CartFull,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Coupons
 * -------------------------------------------------------------------------------------- */

const COUPON_PROBLEM_MESSAGES: Readonly<Record<CouponProblemCode, string>> = {
  // One generic message for unknown codes and codes that match no cart line (§9 brute force).
  coupon_invalid: 'This coupon code is not valid for the courses in your cart.',
  coupon_expired: 'This coupon has expired.',
  coupon_not_started: 'This coupon is not active yet.',
  coupon_exhausted: 'This coupon has been fully redeemed.',
  coupon_already_used: 'You have already used this coupon.',
};

/** 422 `coupon_invalid` | `coupon_expired` | `coupon_not_started` | `coupon_exhausted` | `coupon_already_used`. */
export class CouponNotApplicable extends ValidationError {
  constructor(
    readonly problem: CouponProblemCode,
    options: CauseOption = {},
  ) {
    super(COUPON_PROBLEM_MESSAGES[problem], { code: problem, cause: options.cause });
  }
}

/** 409 `coupon_code_taken`: unique per course, and among platform coupons (D5); never reused. */
export class CouponCodeTaken extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This coupon code is already used for this course.', {
      code: ErrorCode.CouponCodeTaken,
      cause: options.cause,
    });
  }
}

/** 422 `coupon_limit_exceeded`: at most 10 active coupons per course (D5). */
export class CouponLimitExceeded extends ValidationError {
  constructor(maxActive: number, options: CauseOption = {}) {
    super(`A course can have at most ${maxActive} active coupons.`, {
      code: ErrorCode.CouponLimitExceeded,
      cause: options.cause,
    });
  }
}

/** 422 `course_is_free`: a free course has nothing to discount. */
export class CouponOnFreeCourse extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('A free course cannot have coupons.', {
      code: ErrorCode.CourseIsFree,
      cause: options.cause,
    });
  }
}

/** 422 `course_not_for_sale`: set a price before creating coupons (D16). */
export class CouponOnUnpricedCourse extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Set a price for the course before creating coupons.', {
      code: ErrorCode.CourseNotForSale,
      cause: options.cause,
    });
  }
}

/**
 * 404 `not_found`: no such coupon in this scope (another course's coupon id under this course
 * is "not found" too, §9 IDOR). There is no dedicated coupon code in the contracts.
 */
export class CouponNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The coupon does not exist.', { code: ErrorCode.NotFound, cause: options.cause });
  }
}

/** 422 `validation_failed` with field issues (coupon terms the request schema cannot check). */
export class InvalidCommerceField extends ValidationError {
  constructor(issues: readonly DomainFieldIssue[], options: CauseOption = {}) {
    super(issues[0]?.message ?? 'Invalid input.', {
      code: ErrorCode.ValidationFailed,
      issues,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Checkout (design §5 "Checkout", D15, D17). Errors that carry RFC 7807 extension members
 * (`quote`, `orderId`, `checkoutUrl`) or need a status the DomainError kinds lack (400, 503)
 * are turned into HttpExceptions by the presentation's `CommerceProblemsInterceptor`.
 * -------------------------------------------------------------------------------------- */

/** 400 `idempotency_key_required`: `POST /me/checkout` without an `Idempotency-Key` header. */
export class IdempotencyKeyRequired extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('The Idempotency-Key header is required.', {
      code: ErrorCode.IdempotencyKeyRequired,
      issues: [{ path: 'idempotency-key', message: 'Required (a UUID).' }],
      cause: options.cause,
    });
  }
}

/** 403 `email_not_verified` (D17): verify the email before buying. */
export class CheckoutEmailNotVerified extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('Verify your email address before checking out.', {
      code: ErrorCode.EmailNotVerified,
      cause: options.cause,
    });
  }
}

/** 422 `cart_empty`. */
export class CartEmpty extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Your cart is empty.', { code: ErrorCode.CartEmpty, cause: options.cause });
  }
}

/** 422 `amount_below_minimum` (D3): a total in (0, 0.50) cannot be charged. */
export class AmountBelowMinimum extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('The order total is below the minimum amount that can be charged.', {
      code: ErrorCode.AmountBelowMinimum,
      cause: options.cause,
    });
  }
}

/** 422 `idempotency_key_reused`: this key already placed an order for a different request. */
export class IdempotencyKeyReused extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('This Idempotency-Key was already used for a different checkout.', {
      code: ErrorCode.IdempotencyKeyReused,
      cause: options.cause,
    });
  }
}

/** 409 `price_changed` + the fresh quote (`PriceChangedProblem`). */
export class PriceChanged extends ConflictError {
  constructor(
    readonly quote: CartQuote,
    options: CauseOption = {},
  ) {
    super('The price of your cart has changed. Please review it and try again.', {
      code: ErrorCode.PriceChanged,
      cause: options.cause,
    });
  }
}

/** 409 `cart_changed` + the fresh quote (`CartChangedProblem`): a line became unavailable. */
export class CartChanged extends ConflictError {
  constructor(
    readonly quote: CartQuote,
    options: CauseOption = {},
  ) {
    super('Some courses in your cart are no longer available. Please review your cart.', {
      code: ErrorCode.CartChanged,
      cause: options.cause,
    });
  }
}

/** 409 `checkout_in_progress` (D15) + `{ orderId, checkoutUrl }` (`CheckoutInProgressProblem`). */
export class CheckoutInProgress extends ConflictError {
  constructor(
    readonly orderId: string,
    /** Null while the session is still being created. A bearer capability: never log it. */
    readonly checkoutUrl: string | null,
    options: CauseOption = {},
  ) {
    super('You already have a checkout in progress. Resume it or cancel it first.', {
      code: ErrorCode.CheckoutInProgress,
      cause: options.cause,
    });
  }
}

/**
 * 503 `payment_provider_unavailable`: the provider call failed. The order stays CREATING; a
 * retry with the SAME key resumes it (the reconciler cleans up abandoned ones).
 */
export class PaymentProviderUnavailable extends Error {
  readonly code = ErrorCode.PaymentProviderUnavailable;

  constructor(options: CauseOption = {}) {
    super('The payment provider is temporarily unavailable. Please retry.', {
      cause: options.cause,
    });
    this.name = new.target.name;
  }
}

/* ----------------------------------------------------------------------------------------
 * Orders
 * -------------------------------------------------------------------------------------- */

/** 404 `order_not_found` (also for foreign orders: the policy and the use cases agree, §9). */
export class OrderNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The order does not exist.', { code: ErrorCode.OrderNotFound, cause: options.cause });
  }
}

/** 409 `order_not_cancelable`: paid (or being paid), or otherwise closed for cancellation. */
export class OrderNotCancelable extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This order can no longer be canceled.', {
      code: ErrorCode.OrderNotCancelable,
      cause: options.cause,
    });
  }
}

/** 409 `order_not_paid`: a receipt exists only once the order was paid. */
export class OrderNotPaid extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This order has not been paid.', { code: ErrorCode.OrderNotPaid, cause: options.cause });
  }
}
