import { Injectable } from '@nestjs/common';
import type { CourseConsumption } from '@udemy/contracts';
import { consumptionReviewReason, type Executor } from '@udemy/db';
import { CommerceSettings } from './commerce-settings';
import { type CommerceConsumption, CommerceLearning } from './ports/context-gateways';
import {
  type RefundEligibilityInput,
  RefundEligibilityPolicy,
} from './ports/refund-eligibility.policy';

/**
 * The figures as the rule reads them: watched seconds and completed lectures can never exceed
 * their totals (learning clamps them already; this keeps the percentages and the
 * `consumed_*_{pct}` reasons within 0–100 even if a row ever disagreed).
 */
function clamped(c: CommerceConsumption): CommerceConsumption {
  return {
    ...c,
    videoSecondsWatched: Math.min(c.videoSecondsWatched, c.videoSecondsTotal),
    completedLectures: Math.min(c.completedLectures, c.totalLectures),
  };
}

/** The P5-D6 objection for these figures (`@udemy/db` `consumptionReviewReason`); null = none. */
export function consumptionObjection(c: CommerceConsumption, pct: number): string | null {
  return consumptionReviewReason(clamped(c), pct);
}

/** The contracts view (`CourseConsumption`): the figures, the percentages and the objection. */
export function toCourseConsumption(raw: CommerceConsumption, pct: number): CourseConsumption {
  const c = clamped(raw);
  return {
    videoSecondsWatched: c.videoSecondsWatched,
    videoSecondsTotal: c.videoSecondsTotal,
    videoPct:
      c.videoSecondsTotal > 0 ? Math.floor((c.videoSecondsWatched * 100) / c.videoSecondsTotal) : 0,
    completedLectures: c.completedLectures,
    totalLectures: c.totalLectures,
    lecturesPct:
      c.totalLectures > 0 ? Math.floor((c.completedLectures * 100) / c.totalLectures) : 0,
    courseCompletedAt: c.courseCompletedAt?.toISOString() ?? null,
    certificateStatus: c.certificateStatus,
    reviewReason: consumptionReviewReason(c, pct),
  };
}

/**
 * The Phase 5 binding of `RefundEligibilityPolicy` (design D8, P5-D6): commerce owns the rule,
 * learning owns the facts (`LearningFacade.getConsumption`). It objects, in this order, when
 *
 * - the buyer holds an ACTIVE certificate for the course -> `certificate_issued`;
 * - more than `COMMERCE_REFUND_REVIEW_CONSUMED_PCT` (30) percent of the live video seconds was
 *   watched -> `consumed_video_{pct}`;
 * - more than that percent of the live lectures was completed -> `consumed_lectures_{pct}`.
 *
 * An objection turns AUTO_APPROVE into NEEDS_REVIEW (REQUESTED); it never blocks a request.
 * `RequestRefundCommand` calls it inside the refund transaction, after the cart and order
 * locks; the read takes no locks and is at most one progress flush (≤ 15 s) behind.
 */
@Injectable()
export class LearningConsumptionPolicy extends RefundEligibilityPolicy {
  constructor(
    private readonly learning: CommerceLearning,
    private readonly settings: CommerceSettings,
  ) {
    super();
  }

  async objection(input: RefundEligibilityInput, ex: Executor): Promise<string | null> {
    const consumption = await this.learning.getConsumption(input.userId, input.courseId, ex);
    return consumptionObjection(consumption, this.settings.refundReviewConsumedPct);
  }
}

/**
 * Consumption figures for the refund views (Phase 5 D8: the student's order lines for the
 * refund dialog hint, the admin refund queue for the decision). Read live, never stored.
 */
@Injectable()
export class CourseConsumptionViews {
  constructor(
    private readonly learning: CommerceLearning,
    private readonly settings: CommerceSettings,
  ) {}

  async of(userId: string, courseId: string, ex?: Executor): Promise<CourseConsumption> {
    return toCourseConsumption(
      await this.learning.getConsumption(userId, courseId, ex),
      this.settings.refundReviewConsumedPct,
    );
  }

  /**
   * One read per distinct (user, course), sequentially (inside a transaction there is one
   * connection). Keyed by `consumptionKey`.
   */
  async ofMany(
    pairs: readonly { readonly userId: string; readonly courseId: string }[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, CourseConsumption>> {
    const result = new Map<string, CourseConsumption>();
    for (const { userId, courseId } of pairs) {
      const key = consumptionKey(userId, courseId);
      if (!result.has(key)) result.set(key, await this.of(userId, courseId, ex));
    }
    return result;
  }
}

export function consumptionKey(userId: string, courseId: string): string {
  return `${userId}:${courseId}`;
}
