import { Injectable } from '@nestjs/common';
import type { Enrollment as EnrollmentView } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import {
  CannotPurchaseOwnCourse,
  CourseNotForSale,
  CourseNotFound,
  CourseNotFree,
} from '../../domain/enrollment.errors';
import { decideFreeEnrollment } from '../../domain/free-enrollment';
import { EnrollmentWriter } from '../enrollment-writer';
import { CoursePriceReader } from '../ports/course-price.reader';
import { FreeEnrollmentRateLimiter } from '../ports/free-enrollment-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';
import { toEnrollmentView } from '../views';

export interface EnrollFreeInput {
  readonly userId: string;
  readonly courseId: string;
}

export interface EnrollFreeResult {
  readonly enrollment: EnrollmentView;
  /** True for a new grant or a re-grant (201); false when it was already ACTIVE (200). */
  readonly created: boolean;
}

/**
 * `EnrollFree` (design D14, §5): a PUBLISHED course priced at 0.00 that the caller does not
 * own is granted directly with source FREE, no order and no email verification (D17).
 * Idempotent: an ACTIVE enrollment (from any source) is returned unchanged.
 *
 * The course and the price are read before the grant transaction: a price change racing the
 * click is acceptable (the price is "effective immediately", D2) and the grant itself is
 * serialised by the upsert's row lock.
 *
 * Errors: 404 `course_not_found`, 409 `course_not_for_sale` / `course_not_free` /
 * `cannot_purchase_own_course`, 429 `rate_limited` (30 per hour).
 */
@Injectable()
export class EnrollFreeCommand {
  constructor(
    private readonly rateLimiter: FreeEnrollmentRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly prices: CoursePriceReader,
    private readonly writer: EnrollmentWriter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: EnrollFreeInput): Promise<EnrollFreeResult> {
    await this.rateLimiter.hitFreeEnrollment(input.userId);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    const priceAmount = course === null ? null : await this.prices.findPriceAmount(course.id);
    switch (decideFreeEnrollment({ userId: input.userId, course, priceAmount })) {
      case 'COURSE_NOT_FOUND':
        throw new CourseNotFound();
      case 'NOT_FOR_SALE':
        throw new CourseNotForSale();
      case 'NOT_FREE':
        throw new CourseNotFree();
      case 'OWN_COURSE':
        throw new CannotPurchaseOwnCourse();
      case 'ELIGIBLE':
        break;
    }
    const { outcome, enrollment } = await this.tx.run((trx) =>
      this.writer.grant(trx, { userId: input.userId, courseId: input.courseId, source: 'FREE' }),
    );
    return { enrollment: toEnrollmentView(enrollment), created: outcome !== 'ALREADY_ACTIVE' };
  }
}
