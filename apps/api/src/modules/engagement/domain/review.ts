import {
  ErrorCode,
  type ModerationStatus,
  type RatingHistogram,
  ratingAverage,
  type ReviewBlockReason,
  type ReviewState,
} from '@udemy/contracts';

/**
 * Reviews and instructor replies (Phase 5 learning experience design D10, §4 Review). A review
 * is PUBLISHED (public, counted in the aggregate) iff it is VISIBLE, not suspended and not
 * deleted; deleted reviews are never read by the use cases.
 */

/** The live instructor reply of a review (at most one, `review_replies_review_id_live_uq`). */
export interface ReviewReplyRecord {
  readonly id: string;
  readonly reviewId: string;
  readonly authorId: string;
  readonly body: string;
  readonly moderationStatus: ModerationStatus;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
}

/** A non-deleted review with its live reply (if any). */
export interface ReviewRecord {
  readonly id: string;
  readonly courseId: string;
  readonly userId: string;
  readonly rating: number;
  readonly body: string | null;
  readonly moderationStatus: ModerationStatus;
  /** The enrollment was revoked (worker sync, D9); reinstated on a regrant. */
  readonly suspendedAt: Date | null;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly reply: ReviewReplyRecord | null;
}

/**
 * The author/instructor-facing state. Suspension wins over moderation: a suspended review is
 * hidden for a reason the author can fix (re-enrolling), whatever its moderation status.
 */
export function reviewState(
  review: Pick<ReviewRecord, 'moderationStatus' | 'suspendedAt'>,
): ReviewState {
  if (review.suspendedAt !== null) return 'SUSPENDED';
  return review.moderationStatus === 'HIDDEN' ? 'HIDDEN' : 'PUBLISHED';
}

export function isPublished(
  review: Pick<ReviewRecord, 'moderationStatus' | 'suspendedAt'>,
): boolean {
  return reviewState(review) === 'PUBLISHED';
}

/** The reply as everyone sees it: only a VISIBLE one (a hidden reply is simply not shown). */
export function publicReplyOf(review: Pick<ReviewRecord, 'reply'>): ReviewReplyRecord | null {
  return review.reply !== null && review.reply.moderationStatus === 'VISIBLE' ? review.reply : null;
}

/**
 * Instructors reply to PUBLISHED or HIDDEN reviews of their course, never to suspended ones
 * (the reviewer lost access, D9).
 */
export function isRepliable(review: Pick<ReviewRecord, 'suspendedAt'>): boolean {
  return review.suspendedAt === null;
}

export interface ReviewEligibilityFacts {
  readonly isOwner: boolean;
  readonly hasActiveEnrollment: boolean;
  /** Completed lectures of the live revision. */
  readonly completedLectures: number;
}

/**
 * D10 / P5-D8, in this order (the contracts mock store uses the same order): the owner never
 * reviews, then an ACTIVE enrollment, then at least one completed lecture. Null = eligible.
 */
export function reviewBlockReason(facts: ReviewEligibilityFacts): ReviewBlockReason | null {
  if (facts.isOwner) return ErrorCode.CannotReviewOwnCourse;
  if (!facts.hasActiveEnrollment) return ErrorCode.EnrollmentRequired;
  if (facts.completedLectures < 1) return ErrorCode.ReviewNotEligible;
  return null;
}

/** The read model row of one course (`course_rating_stats`); counts[0] = 1 star. */
export interface CourseRatingStats {
  readonly courseId: string;
  readonly reviewCount: number;
  /** numeric(2,1) as text, e.g. `4.3`; null without reviews. */
  readonly average: string | null;
  readonly counts: readonly [number, number, number, number, number];
}

export interface CourseRatingView {
  readonly courseId: string;
  readonly average: string | null;
  readonly count: number;
  readonly histogram: RatingHistogram;
}

/**
 * The public rating of a course. A course without a read-model row has no reviews yet
 * (`{ count: 0, average: null }`). The average is the read model's generated column; if it is
 * ever missing while the histogram is not empty, it is recomputed with the same rounding.
 */
export function toCourseRating(
  courseId: string,
  stats: CourseRatingStats | undefined,
): CourseRatingView {
  const counts = stats?.counts ?? [0, 0, 0, 0, 0];
  const histogram: RatingHistogram = {
    '1': counts[0],
    '2': counts[1],
    '3': counts[2],
    '4': counts[3],
    '5': counts[4],
  };
  const count = counts.reduce((sum, n) => sum + n, 0);
  const average = count === 0 ? null : (stats?.average ?? ratingAverage(histogram));
  return { courseId, average, count, histogram };
}
