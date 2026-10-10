/**
 * Free enrollment eligibility (commerce & enrollment design D14, §4 "Purchase eligibility",
 * §5 `EnrollFree`). Pure rules; the use case loads the facts. Checked in this order:
 *
 * 1. the course has a live revision, else `COURSE_NOT_FOUND` (404);
 * 2. it is PUBLISHED (an archived course is not for sale), else `NOT_FOR_SALE` (409);
 * 3. it has a price row (D16: no price = not for sale), else `NOT_FOR_SALE`;
 * 4. the price is 0.00, else `NOT_FREE` (409; buy it through checkout);
 * 5. the caller is not the owner, else `OWN_COURSE` (409).
 *
 * "Already enrolled" is not a refusal: the grant is idempotent (200 with the enrollment).
 */

export interface FreeEnrollmentFacts {
  readonly userId: string;
  /** The course as catalog shows it to other contexts; null without a live revision. */
  readonly course: { readonly status: 'PUBLISHED' | 'ARCHIVED'; readonly ownerId: string } | null;
  /** The decimal amount exactly as Postgres printed it (`'0.00'`); null without a price row. */
  readonly priceAmount: string | null;
}

export type FreeEnrollmentDecision =
  'ELIGIBLE' | 'COURSE_NOT_FOUND' | 'NOT_FOR_SALE' | 'NOT_FREE' | 'OWN_COURSE';

const ZERO_DECIMAL = /^0+(?:\.0+)?$/;

/** `'0.00'`, `'0'`: free. Decimal strings only, never floats (Kysely returns numeric as text). */
export function isZeroAmount(amount: string): boolean {
  return ZERO_DECIMAL.test(amount.trim());
}

export function decideFreeEnrollment(facts: FreeEnrollmentFacts): FreeEnrollmentDecision {
  if (facts.course === null) return 'COURSE_NOT_FOUND';
  if (facts.course.status !== 'PUBLISHED') return 'NOT_FOR_SALE';
  if (facts.priceAmount === null) return 'NOT_FOR_SALE';
  if (!isZeroAmount(facts.priceAmount)) return 'NOT_FREE';
  if (facts.course.ownerId === facts.userId) return 'OWN_COURSE';
  return 'ELIGIBLE';
}
