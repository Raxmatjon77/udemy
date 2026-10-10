import {
  COUPON_LIMITS,
  type CouponProblemCode,
  type CouponScope,
  type CouponState,
  ErrorCode,
} from '@udemy/contracts';
import type { DomainFieldIssue } from '@udemy/nest-common/errors';
import { Money } from './money';

export type CouponDiscount =
  | { readonly type: 'PERCENT'; readonly percentOff: number }
  | { readonly type: 'AMOUNT'; readonly amountOff: Money };

export interface CouponTermsProps {
  readonly id: string;
  readonly scope: CouponScope;
  /** Set iff scope = COURSE. */
  readonly courseId: string | null;
  readonly discount: CouponDiscount;
}

/** A coupon row as the DB returns it (numeric as a decimal string). */
export interface CouponTermsRow {
  readonly id: string;
  readonly scope: string;
  readonly courseId: string | null;
  readonly discountType: string;
  readonly percentOff: number | null;
  readonly amountOff: string | null;
  readonly currency: string | null;
}

/**
 * The immutable discount terms of a coupon (design D5): a COURSE coupon (one course, by its
 * instructor) or a PLATFORM coupon (every course, by an admin; PERCENT only). PERCENT 1–100 is
 * rounded half up; AMOUNT is off the list price, capped at it (final >= 0). Mirrors
 * `commerce.coupon_discount` exactly (property-tested, and checked against the SQL in IT).
 */
export class CouponTerms {
  private constructor(private readonly props: CouponTermsProps) {}

  static of(props: CouponTermsProps): CouponTerms {
    if ((props.scope === 'COURSE') !== (props.courseId !== null)) {
      throw new RangeError('A COURSE coupon has a courseId, a PLATFORM coupon has none');
    }
    if (props.discount.type === 'PERCENT') {
      const p = props.discount.percentOff;
      if (
        !Number.isInteger(p) ||
        p < COUPON_LIMITS.minPercentOff ||
        p > COUPON_LIMITS.maxPercentOff
      ) {
        throw new RangeError(`percentOff must be an integer in 1–100, got ${p}`);
      }
    } else {
      if (props.scope === 'PLATFORM') throw new RangeError('Platform coupons are PERCENT only');
      if (!props.discount.amountOff.isPositive()) throw new RangeError('amountOff must be > 0');
    }
    return new CouponTerms(props);
  }

  /** @throws RangeError for a row that breaks the `coupons` CHECKs (cannot come from the DB) */
  static fromRow(row: CouponTermsRow): CouponTerms {
    const scope = row.scope === 'COURSE' || row.scope === 'PLATFORM' ? row.scope : null;
    if (scope === null) throw new RangeError(`Unknown coupon scope ${row.scope}`);
    let discount: CouponDiscount;
    if (row.discountType === 'PERCENT' && row.percentOff !== null) {
      discount = { type: 'PERCENT', percentOff: row.percentOff };
    } else if (row.discountType === 'AMOUNT' && row.amountOff !== null && row.currency !== null) {
      discount = { type: 'AMOUNT', amountOff: Money.fromDecimal(row.amountOff, row.currency) };
    } else {
      throw new RangeError(`Malformed coupon terms for ${row.id}`);
    }
    return CouponTerms.of({ id: row.id, scope, courseId: row.courseId, discount });
  }

  get id(): string {
    return this.props.id;
  }

  get scope(): CouponScope {
    return this.props.scope;
  }

  get courseId(): string | null {
    return this.props.courseId;
  }

  get discount(): CouponDiscount {
    return this.props.discount;
  }

  /** A COURSE coupon applies to its course only; a PLATFORM coupon to every course. */
  appliesTo(courseId: string): boolean {
    return this.props.scope === 'PLATFORM' || this.props.courseId === courseId;
  }

  /**
   * The discount on one list price: PERCENT half up, AMOUNT capped at the list price. null when
   * the coupon cannot apply to an amount in that currency (an AMOUNT coupon of another
   * currency; the quote SQL skips those too).
   */
  discountFor(list: Money): Money | null {
    const d = this.props.discount;
    if (d.type === 'PERCENT') return list.percentOf(d.percentOff);
    if (d.amountOff.currency !== list.currency) return null;
    return d.amountOff.min(list);
  }
}

/** A coupon that matched the cart's code, with its derived state at the quote's `now()`. */
export interface CouponCandidate {
  readonly terms: CouponTerms;
  readonly state: CouponState;
  /** The user holds a RESERVED or CONSUMED redemption (one per user per coupon, D5). */
  readonly usedByMe: boolean;
}

export interface BestCoupon {
  readonly couponId: string;
  readonly scope: CouponScope;
  readonly discount: Money;
}

/** ACTIVE (started, not expired, not exhausted, not deactivated) and not yet used by the user. */
export function isRedeemable(candidate: CouponCandidate): boolean {
  return candidate.state === 'ACTIVE' && !candidate.usedByMe;
}

/**
 * Best-of per cart line (D5): among the redeemable coupons with the cart's code that apply to
 * the course, the highest discount wins; a tie goes to the COURSE coupon, then the lowest id
 * (the quote SQL's `ORDER BY discount DESC, (scope = 'COURSE') DESC, id`). No stacking. null
 * when nothing applies, or for a free line (nothing to discount).
 */
export function selectBestCoupon(
  line: { readonly courseId: string; readonly list: Money },
  candidates: readonly CouponCandidate[],
): BestCoupon | null {
  if (!line.list.isPositive()) return null;
  let best: BestCoupon | null = null;
  for (const candidate of candidates) {
    if (!isRedeemable(candidate) || !candidate.terms.appliesTo(line.courseId)) continue;
    const discount = candidate.terms.discountFor(line.list);
    if (discount === null) continue;
    const option: BestCoupon = {
      couponId: candidate.terms.id,
      scope: candidate.terms.scope,
      discount,
    };
    if (best === null || beats(option, best)) best = option;
  }
  return best;
}

function beats(a: BestCoupon, b: BestCoupon): boolean {
  const byDiscount = a.discount.compare(b.discount);
  if (byDiscount !== 0) return byDiscount > 0;
  if (a.scope !== b.scope) return a.scope === 'COURSE';
  return a.couponId < b.couponId;
}

/**
 * Why the cart's code gives no discount (design §9, "reveal only after the code is right"):
 *
 * - no candidate for a purchasable line (unknown code, another course's code, or a code of a
 *   course that is not purchasable right now): the generic `coupon_invalid`;
 * - otherwise the most actionable state among the candidates, in this order:
 *   `coupon_already_used`, `coupon_exhausted`, `coupon_not_started`, `coupon_expired`;
 *   a deactivated coupon (or an ACTIVE one that still cannot apply) is `coupon_invalid`.
 *
 * Only meaningful when no purchasable line received a discount.
 */
export function couponProblem(
  candidates: readonly CouponCandidate[],
  purchasableCourseIds: readonly string[],
): CouponProblemCode {
  const relevant = candidates.filter((c) =>
    purchasableCourseIds.some((courseId) => c.terms.appliesTo(courseId)),
  );
  const has = (predicate: (c: CouponCandidate) => boolean): boolean => relevant.some(predicate);
  if (has((c) => c.usedByMe && c.state !== 'DEACTIVATED')) return ErrorCode.CouponAlreadyUsed;
  if (has((c) => c.state === 'EXHAUSTED')) return ErrorCode.CouponExhausted;
  if (has((c) => c.state === 'SCHEDULED')) return ErrorCode.CouponNotStarted;
  if (has((c) => c.state === 'EXPIRED')) return ErrorCode.CouponExpired;
  return ErrorCode.CouponInvalid;
}

/* ----------------------------------------------------------------------------------------
 * Creation rules that need a clock or the list price (the request schemas check the rest)
 * -------------------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CouponWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

function windowIssues(
  window: CouponWindow,
  now: Date,
  minDays: number,
  maxDays: number,
): DomainFieldIssue[] {
  const issues: DomainFieldIssue[] = [];
  const startMs = window.startsAt.getTime();
  const endMs = window.endsAt.getTime();
  if (startMs > now.getTime() + COUPON_LIMITS.maxStartAheadDays * DAY_MS) {
    issues.push({
      path: 'startsAt',
      message: `Must be at most ${COUPON_LIMITS.maxStartAheadDays} days ahead.`,
    });
  }
  if (endMs <= now.getTime()) {
    issues.push({ path: 'endsAt', message: 'Must be in the future.' });
  } else if (endMs <= startMs) {
    issues.push({ path: 'endsAt', message: 'Must be after startsAt.' });
  } else {
    const days = (endMs - startMs) / DAY_MS;
    if (days < minDays || days > maxDays) {
      issues.push({
        path: 'endsAt',
        message: `The coupon must run for ${minDays}–${maxDays} days.`,
      });
    }
  }
  return issues;
}

/**
 * CreateCourseCoupon (design §5): a 1–31 day window starting at most 90 days ahead and ending
 * in the future; an AMOUNT discount in the list currency, > 0 and at most the current list
 * price. Returns the field issues (empty = valid).
 */
export function courseCouponIssues(input: {
  readonly window: CouponWindow;
  readonly now: Date;
  readonly discount: CouponDiscount;
  readonly listPrice: Money;
}): DomainFieldIssue[] {
  const issues = windowIssues(
    input.window,
    input.now,
    COUPON_LIMITS.courseWindowMinDays,
    COUPON_LIMITS.courseWindowMaxDays,
  );
  const d = input.discount;
  if (d.type === 'AMOUNT') {
    if (d.amountOff.currency !== input.listPrice.currency) {
      issues.push({ path: 'amountOff', message: 'Must be in the course price currency.' });
    } else if (!d.amountOff.isPositive() || d.amountOff.compare(input.listPrice) > 0) {
      issues.push({
        path: 'amountOff',
        message: `Must be greater than 0.00 and at most the list price (${input.listPrice.toDecimal()}).`,
      });
    }
  }
  return issues;
}

/** CreatePlatformCoupon (design §5): PERCENT only, a window of at most 90 days. */
export function platformCouponIssues(input: {
  readonly window: CouponWindow;
  readonly now: Date;
}): DomainFieldIssue[] {
  return windowIssues(input.window, input.now, 0, COUPON_LIMITS.platformWindowMaxDays);
}
