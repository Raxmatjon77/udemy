import type { Executor } from '@udemy/db';

/**
 * "What does this course cost?" for the free enrollment (D14: `amount = 0.00` means free).
 *
 * A port, because the price belongs to commerce, and commerce depends on enrollment
 * (`EnrollmentFacade.grant` in the PAID transaction): enrollment cannot import commerce
 * without a module cycle. The adapter reads the one `commerce.course_prices` row.
 */
export abstract class CoursePriceReader {
  /** The decimal amount exactly as Postgres prints it (`'0.00'`), or null without a price row. */
  abstract findPriceAmount(courseId: string, ex?: Executor): Promise<string | null>;
}
