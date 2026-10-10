import type { CartQuote, Coupon, CoursePriceChange, CoursePricing } from '@udemy/contracts';
import { Money } from '../domain/money';
import type { Quote } from '../domain/quote';
import type { CommercePerson } from './ports/context-gateways';
import type { CouponRecord } from './ports/coupon.repository';
import type { CoursePriceRecord, PriceChangeRecord } from './ports/pricing.repository';

/** Domain quote -> the contracts `CartQuote` (instructor names from identity; banned = null). */
export function toCartQuoteView(
  quote: Quote,
  people: ReadonlyMap<string, CommercePerson>,
): CartQuote {
  return {
    currency: quote.currency,
    lines: quote.lines.map((line) => {
      const person = people.get(line.course.ownerId);
      return {
        courseId: line.course.id,
        slug: line.course.slug,
        title: line.course.title,
        instructor:
          person === undefined || person.banned
            ? null
            : { id: line.course.ownerId, displayName: person.displayName },
        hasThumbnail: line.course.hasThumbnail,
        listAmount: line.list.toDecimal(),
        discountAmount: line.discount.toDecimal(),
        finalAmount: line.final.toDecimal(),
        couponId: line.couponId,
        addedAt: line.addedAt.toISOString(),
      };
    }),
    unavailable: quote.unavailable.map((u) => ({
      courseId: u.courseId,
      title: u.title,
      reason: u.reason,
      addedAt: u.addedAt.toISOString(),
    })),
    coupon: quote.coupon === null ? null : { ...quote.coupon },
    totals: {
      listAmount: quote.totals.list.toDecimal(),
      discountAmount: quote.totals.discount.toDecimal(),
      totalAmount: quote.totals.total.toDecimal(),
    },
    itemCount: quote.itemCount,
    fingerprint: quote.fingerprint,
  };
}

export function toPriceChangeView(change: PriceChangeRecord): CoursePriceChange {
  // Re-validated through Money: a malformed or non-allow-listed row is a 500, never output.
  const amount = Money.fromDecimal(change.amount, change.currency);
  return {
    id: change.id,
    previousAmount: change.previousAmount,
    amount: amount.toDecimal(),
    currency: amount.currency,
    changedBy: change.changedBy,
    changedAt: change.changedAt.toISOString(),
  };
}

export function toCoursePricingView(
  courseId: string,
  price: CoursePriceRecord | null,
  history: readonly PriceChangeRecord[],
): CoursePricing {
  const money = price === null ? null : Money.fromDecimal(price.amount, price.currency);
  return {
    courseId,
    price: money === null ? null : money.toJSON(),
    isFree: money?.isZero() ?? false,
    history: history.map(toPriceChangeView),
  };
}

export function toCouponView(coupon: CouponRecord): Coupon {
  const amountOff =
    coupon.amountOff === null || coupon.currency === null
      ? null
      : Money.fromDecimal(coupon.amountOff, coupon.currency);
  return {
    id: coupon.id,
    scope: coupon.scope,
    courseId: coupon.courseId,
    code: coupon.code,
    discountType: coupon.discountType,
    percentOff: coupon.percentOff,
    amountOff: amountOff?.toDecimal() ?? null,
    currency: amountOff?.currency ?? null,
    startsAt: coupon.startsAt.toISOString(),
    endsAt: coupon.endsAt.toISOString(),
    maxRedemptions: coupon.maxRedemptions,
    state: coupon.state,
    redemptions: { reserved: coupon.reserved, consumed: coupon.consumed },
    createdBy: coupon.createdBy,
    createdAt: coupon.createdAt.toISOString(),
    deactivatedAt: coupon.deactivatedAt?.toISOString() ?? null,
  };
}
