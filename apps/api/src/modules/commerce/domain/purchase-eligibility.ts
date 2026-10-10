import { ErrorCode, type PurchaseBlockReason } from '@udemy/contracts';
import type { Money } from './money';

/** What commerce knows about a course when deciding whether a user may buy it. */
export interface SellableCourse {
  readonly id: string;
  readonly ownerId: string;
  /** From `CatalogFacade.getCourseSummaries`: only PUBLISHED courses are sold. */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
}

export interface EligibilityInput {
  /** null: unknown, never published or deleted (omitted by the catalog facade). */
  readonly course: SellableCourse | null;
  /** null: no `course_prices` row, the course is not for sale (D16). */
  readonly price: Money | null;
  /** The platform currency; a price in another currency is not sellable. */
  readonly currency: string;
  readonly userId: string;
  /** The user has an ACTIVE enrollment in the course. */
  readonly enrolled: boolean;
}

/**
 * Purchase eligibility of a course for a user (design §4), each check in order with its
 * reason; null when the course can be bought:
 *
 * 0. the course exists (has a live revision): `course_not_found`
 * 1. it is PUBLISHED: `course_not_for_sale`
 * 2. a price row exists (in the platform currency): `course_not_for_sale`
 * 3. the price is not 0.00: `course_is_free`
 * 4. the user is not the owner: `cannot_purchase_own_course`
 * 5. the user is not ACTIVE-enrolled: `already_enrolled`
 */
export function purchaseBlockReason(input: EligibilityInput): PurchaseBlockReason | null {
  if (input.course === null) return ErrorCode.CourseNotFound;
  if (input.course.status !== 'PUBLISHED') return ErrorCode.CourseNotForSale;
  if (input.price === null || input.price.currency !== input.currency) {
    return ErrorCode.CourseNotForSale;
  }
  if (input.price.isZero()) return ErrorCode.CourseIsFree;
  if (input.course.ownerId === input.userId) return ErrorCode.CannotPurchaseOwnCourse;
  if (input.enrolled) return ErrorCode.AlreadyEnrolled;
  return null;
}
