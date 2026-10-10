import { createHash } from 'node:crypto';
import type { CouponProblemCode, Currency, PurchaseBlockReason } from '@udemy/contracts';
import { type CouponCandidate, couponProblem, selectBestCoupon } from './coupon-terms';
import { Money } from './money';
import { purchaseBlockReason, type SellableCourse } from './purchase-eligibility';

/** One `quoteCart` line (schema doc §8.1): the DB picked the best coupon and rounded it. */
export interface QuoteRow {
  readonly courseId: string;
  readonly addedAt: Date;
  /** null = no price row (not for sale, D16). */
  readonly listAmount: string | null;
  readonly currency: string | null;
  readonly couponId: string | null;
  readonly discountAmount: string;
}

/** A cart course as the catalog facade describes it (live revision). */
export interface QuoteCourse extends SellableCourse {
  readonly slug: string;
  readonly title: string;
  readonly hasThumbnail: boolean;
}

export interface QuoteInput {
  /** The platform currency (COMMERCE_CURRENCY). */
  readonly currency: Currency;
  readonly userId: string;
  /** `carts.coupon_code` (stored uppercased), or null. */
  readonly couponCode: string | null;
  readonly rows: readonly QuoteRow[];
  readonly candidates: readonly CouponCandidate[];
  /** PUBLISHED or ARCHIVED courses among the cart's ids (missing = unknown/deleted). */
  readonly courses: ReadonlyMap<string, QuoteCourse>;
  readonly enrolledCourseIds: ReadonlySet<string>;
}

export interface QuotedLine {
  readonly course: QuoteCourse;
  readonly addedAt: Date;
  readonly list: Money;
  readonly discount: Money;
  readonly final: Money;
  readonly couponId: string | null;
}

export interface UnavailableLine {
  readonly courseId: string;
  /** null when the course no longer exists. */
  readonly title: string | null;
  readonly reason: PurchaseBlockReason;
  readonly addedAt: Date;
}

export interface QuoteCoupon {
  readonly code: string;
  readonly applied: boolean;
  readonly problem: CouponProblemCode | null;
}

/** A purchasable line where the domain's best-of choice differs from the SQL's (see below). */
export interface QuoteDivergence {
  readonly courseId: string;
  readonly sql: { readonly couponId: string | null; readonly discount: string };
  readonly domain: { readonly couponId: string | null; readonly discount: string };
}

/** `GetCart` = the quote (design §4, §5). */
export interface Quote {
  readonly currency: Currency;
  /** Purchasable lines, in cart order (added_at, course_id). */
  readonly lines: readonly QuotedLine[];
  /** Lines that cannot be bought right now (with the first failing eligibility check). */
  readonly unavailable: readonly UnavailableLine[];
  /** The cart's code; reported (applied=false + problem), never silently dropped. */
  readonly coupon: QuoteCoupon | null;
  readonly totals: { readonly list: Money; readonly discount: Money; readonly total: Money };
  readonly itemCount: number;
  /** Lowercase hex SHA-256 (`quoteFingerprint`); checkout compares it per Idempotency-Key. */
  readonly fingerprint: string;
  /**
   * Lines where `selectBestCoupon` over the candidates disagrees with the SQL's pick. The SQL
   * wins (it is the rounding authority, D3); a divergence is only expected when a concurrent
   * redemption committed between the two quote statements, so callers log it.
   */
  readonly divergences: readonly QuoteDivergence[];
}

/**
 * Assembles the quote from the `quoteCart` rows plus the facades' facts:
 *
 * - every line runs the purchase-eligibility checks in order (§4); a failing line moves to
 *   `unavailable` (its coupon, if any, is dropped);
 * - purchasable lines keep the DB's price, coupon and discount (`commerce.coupon_discount`),
 *   and `final = list - discount`;
 * - totals are exact integer sums; the coupon is `applied` when at least one purchasable line
 *   got a discount, otherwise its problem is derived from the candidates.
 *
 * @throws RangeError when a row breaks the money invariants (a DB bug, never user input)
 */
export function assembleQuote(input: QuoteInput): Quote {
  const lines: QuotedLine[] = [];
  const unavailable: UnavailableLine[] = [];
  const divergences: QuoteDivergence[] = [];

  for (const row of input.rows) {
    const course = input.courses.get(row.courseId) ?? null;
    const list =
      row.listAmount === null || row.currency === null
        ? null
        : Money.fromDecimal(row.listAmount, row.currency);
    const reason = purchaseBlockReason({
      course,
      price: list,
      currency: input.currency,
      userId: input.userId,
      enrolled: input.enrolledCourseIds.has(row.courseId),
    });
    if (reason !== null || course === null || list === null) {
      unavailable.push({
        courseId: row.courseId,
        title: course?.title ?? null,
        reason: reason ?? 'course_not_found',
        addedAt: row.addedAt,
      });
      continue;
    }
    const discount = Money.fromDecimal(row.discountAmount, list.currency);
    if (discount.compare(list) > 0 || (row.couponId === null) !== discount.isZero()) {
      throw new RangeError(`Quote row for ${row.courseId} breaks 0 <= discount <= list`);
    }
    lines.push({
      course,
      addedAt: row.addedAt,
      list,
      discount,
      final: list.minusFloored(discount),
      couponId: row.couponId,
    });

    const best = selectBestCoupon({ courseId: row.courseId, list }, input.candidates);
    const domainCoupon = best?.couponId ?? null;
    const domainDiscount = best?.discount ?? Money.zero(list.currency);
    if (domainCoupon !== row.couponId || !domainDiscount.equals(discount)) {
      divergences.push({
        courseId: row.courseId,
        sql: { couponId: row.couponId, discount: discount.toDecimal() },
        domain: { couponId: domainCoupon, discount: domainDiscount.toDecimal() },
      });
    }
  }

  const currency = input.currency;
  const totals = {
    list: Money.sum(
      lines.map((l) => l.list),
      currency,
    ),
    discount: Money.sum(
      lines.map((l) => l.discount),
      currency,
    ),
    total: Money.sum(
      lines.map((l) => l.final),
      currency,
    ),
  };

  let coupon: QuoteCoupon | null = null;
  if (input.couponCode !== null) {
    const applied = lines.some((l) => l.couponId !== null);
    coupon = {
      code: input.couponCode,
      applied,
      problem: applied
        ? null
        : couponProblem(
            input.candidates,
            lines.map((l) => l.course.id),
          ),
    };
  }

  return {
    currency,
    lines,
    unavailable,
    coupon,
    totals,
    itemCount: lines.length + unavailable.length,
    fingerprint: quoteFingerprint(currency, lines),
    divergences,
  };
}

/**
 * The quote fingerprint (design §4, `orders.request_fingerprint`): SHA-256 (lowercase hex) of
 * the currency, the purchasable lines' `courseId:final` pairs sorted by course id, and the
 * sorted distinct coupon ids used. Unavailable lines are not part of it (checkout refuses a
 * cart with any, `cart_changed`). The order stores the 32 raw bytes of this digest.
 */
export function quoteFingerprint(
  currency: Currency,
  lines: readonly {
    readonly course: { readonly id: string };
    readonly final: Money;
    readonly couponId: string | null;
  }[],
): string {
  const pairs = lines
    .map((l) => `${l.course.id}:${l.final.toDecimal()}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const couponIds = [
    ...new Set(lines.flatMap((l) => (l.couponId === null ? [] : [l.couponId]))),
  ].sort();
  return createHash('sha256')
    .update([currency, pairs.join(','), couponIds.join(',')].join('|'), 'utf8')
    .digest('hex');
}
