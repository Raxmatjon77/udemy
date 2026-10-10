import { Injectable, Logger } from '@nestjs/common';
import type { CartQuote } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { CouponTerms } from '../domain/coupon-terms';
import { assembleQuote, type Quote } from '../domain/quote';
import { CommerceSettings } from './commerce-settings';
import { CartRepository } from './ports/cart.repository';
import { CommerceCatalog, CommerceEnrollments, CommercePeople } from './ports/context-gateways';
import { toCartQuoteView } from './views';

export interface PricedCart {
  /** The domain quote (P4-T15 checkout compares its total and fingerprint). */
  readonly quote: Quote;
  /** The contracts `CartQuote` (HTTP). */
  readonly view: CartQuote;
}

/**
 * Builds the cart quote (design §4/§5 `GetCart`; also the "re-quote" step of checkout, which
 * calls it on its own transaction after the cart and coupon locks, schema doc §8.2):
 *
 * 1. `quoteCart` (DB prices, best coupon per line, rounding by `commerce.coupon_discount`) and
 *    the coupon candidates, in ONE transaction so both statements share `now()`;
 * 2. `CatalogFacade.getCourseSummaries` + `EnrollmentFacade.activeCourseIds` (eligibility);
 * 3. the domain `assembleQuote` (eligibility order, totals, coupon problem, fingerprint);
 * 4. instructor display names from identity.
 */
@Injectable()
export class CartQuoteService {
  private readonly logger = new Logger(CartQuoteService.name);

  constructor(
    private readonly carts: CartRepository,
    private readonly catalog: CommerceCatalog,
    private readonly enrollments: CommerceEnrollments,
    private readonly people: CommercePeople,
    private readonly settings: CommerceSettings,
  ) {}

  /** `ex` should be a transaction (see 1.); the cart lock is the caller's business. */
  async price(userId: string, ex: Executor): Promise<PricedCart> {
    const couponCode = await this.carts.findCouponCode(userId, ex);
    const raw = await this.carts.quote(userId, ex);
    const courseIds = raw.lines.map((l) => l.courseId);
    const courses = await this.catalog.getCourses(courseIds, ex);
    const enrolled =
      courseIds.length === 0
        ? new Set<string>()
        : await this.enrollments.activeCourseIds(userId, courseIds, ex);
    const quote = assembleQuote({
      currency: this.settings.currency,
      userId,
      couponCode,
      rows: raw.lines,
      candidates: raw.candidates.map((c) => ({
        terms: CouponTerms.fromRow(c),
        state: c.state,
        usedByMe: c.usedByMe,
      })),
      courses: new Map(courses.map((c) => [c.id, c])),
      enrolledCourseIds: enrolled,
    });
    if (quote.divergences.length > 0) {
      // Expected only when a redemption committed between the two quote statements.
      this.logger.warn(
        `cart quote: SQL and domain best-of differ for user ${userId}: ${JSON.stringify(quote.divergences)}`,
      );
    }
    const people = await this.people.findPeople(
      [...new Set(quote.lines.map((l) => l.course.ownerId))],
      ex,
    );
    return { quote, view: toCartQuoteView(quote, people) };
  }
}
