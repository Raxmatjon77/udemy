import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { PersonRefSchema } from './catalog';
import { uuidListParam } from './commerce-common';
import { IsoDateTimeSchema, multilineText, UuidSchema } from './fields';
import type { RateLimitRule } from './learning';
import { CompactPaginationQuerySchema, emptyToUndefined, pageSchema } from './pagination';

/**
 * Reviews, replies and ratings (Phase 5 learning experience design D10, D11, §4 Review, §5, §8).
 * Bodies are **plain text** (D22): rendered as React text, never as markdown, because they are
 * public and SEO-visible.
 */

export const REVIEW_RATINGS = [1, 2, 3, 4, 5] as const;
export const ReviewRatingSchema = z.number().int().min(1).max(5);
export type ReviewRating = z.infer<typeof ReviewRatingSchema>;

/** `reviews.body` / `review_replies.body` 1–2000, plain text (trimmed, line breaks allowed). */
export const ReviewBodySchema = multilineText(1, 2000);
export const ReviewReplyBodySchema = multilineText(1, 2000);

/**
 * The author-facing state of a review (`moderation_status` + `suspended_at`; deleted reviews
 * are gone). Only PUBLISHED reviews are public and counted in the aggregate (§4).
 */
export const REVIEW_STATES = ['PUBLISHED', 'HIDDEN', 'SUSPENDED'] as const;
export const ReviewStateSchema = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** Engagement rate limits (§9); a hit is 429 `rate_limited` with `Retry-After`. */
export const ENGAGEMENT_RATE_LIMITS = Object.freeze({
  reviewWrite: { limit: 20, windowSeconds: 86_400, per: 'user' },
  questionPost: { limit: 20, windowSeconds: 86_400, per: 'user' },
  answerPost: { limit: 100, windowSeconds: 86_400, per: 'user' },
  vote: { limit: 300, windowSeconds: 3600, per: 'user' },
  report: { limit: 30, windowSeconds: 86_400, per: 'user' },
  /** Plus the DB quota of `ANNOUNCEMENT_LIMITS.perCourse` per course per 30 days. */
  announcementPost: { limit: 20, windowSeconds: 86_400, per: 'instructor' },
  wishlistWrite: { limit: 200, windowSeconds: 3600, per: 'user' },
  publicRead: { limit: 240, windowSeconds: 60, per: 'ip' },
} as const satisfies Record<string, RateLimitRule>);

/* ----------------------------------------------------------------------------------------
 * GET /engagement/ratings?courseIds=a,b -> 200 { items } (public, student BFF, C + @Public)
 * `Cache-Control: public, max-age=60`. One item per requested id; a course without reviews is
 * `{ count: 0, average: null }` (the read model is eventually consistent, D11).
 * -------------------------------------------------------------------------------------- */

export const PUBLIC_RATINGS_MAX_IDS = 48;
export const PUBLIC_ENGAGEMENT_CACHE_CONTROL = 'public, max-age=60';

export const RatingsQuerySchema = z.object({ courseIds: uuidListParam(PUBLIC_RATINGS_MAX_IDS) });
export type RatingsQuery = z.output<typeof RatingsQuerySchema>;

/** Decimal string with one decimal place, e.g. `4.6` (never a float on the wire). */
export const RATING_AVERAGE_PATTERN = /^[1-5]\.\d$/;
export const RatingAverageSchema = z
  .string()
  .regex(RATING_AVERAGE_PATTERN, 'Invalid rating average')
  .meta({ examples: ['4.6'] });

export const RatingHistogramSchema = z.object({
  '1': z.number().int().min(0),
  '2': z.number().int().min(0),
  '3': z.number().int().min(0),
  '4': z.number().int().min(0),
  '5': z.number().int().min(0),
});
export type RatingHistogram = z.infer<typeof RatingHistogramSchema>;

export const CourseRatingSchema = z
  .object({
    courseId: UuidSchema,
    /** Null when there are no reviews. */
    average: RatingAverageSchema.nullable(),
    count: z.number().int().min(0),
    histogram: RatingHistogramSchema,
  })
  .refine(
    (r) =>
      (r.count === 0) === (r.average === null) &&
      Object.values(r.histogram).reduce((sum, n) => sum + n, 0) === r.count,
    { message: 'average is null exactly when count is 0; the histogram sums to count' },
  );
export type CourseRating = z.infer<typeof CourseRatingSchema>;

export const RatingsResponseSchema = z.object({ items: z.array(CourseRatingSchema) });
export type RatingsResponse = z.infer<typeof RatingsResponseSchema>;

/** The average as the read model computes it: rating_sum / count, rounded half up to 1 dp. */
export function ratingAverage(histogram: RatingHistogram): string | null {
  const count = REVIEW_RATINGS.reduce((sum, r) => sum + histogram[`${r}`], 0);
  if (count === 0) return null;
  const sum = REVIEW_RATINGS.reduce((acc, r) => acc + r * histogram[`${r}`], 0);
  const tenths = Math.floor((sum * 10 * 2 + count) / (2 * count));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/* ----------------------------------------------------------------------------------------
 * GET /engagement/courses/:courseId/reviews?rating=&cursor=&limit= -> 200 PublicReviewPage
 * (public, `Cache-Control: public, max-age=60`; 404 course_not_found, 429). PUBLISHED reviews
 * only, keyset (createdAt DESC, id DESC).
 * -------------------------------------------------------------------------------------- */

export const PublicReviewsQuerySchema = CompactPaginationQuerySchema.extend({
  rating: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(5).optional()),
});
export type PublicReviewsQuery = z.output<typeof PublicReviewsQuerySchema>;

/** The instructor's reply as everyone sees it. */
export const PublicReviewReplySchema = z.object({
  body: z.string(),
  /** Null when the instructor is banned. */
  author: PersonRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
});
export type PublicReviewReply = z.infer<typeof PublicReviewReplySchema>;

export const PublicReviewSchema = z.object({
  id: UuidSchema,
  rating: ReviewRatingSchema,
  body: z.string().nullable(),
  /** Public profile only; null for a banned author ("Former student"). */
  author: PersonRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  /** Null when there is none or it is hidden. */
  reply: PublicReviewReplySchema.nullable(),
});
export type PublicReview = z.infer<typeof PublicReviewSchema>;

export const PublicReviewPageSchema = pageSchema(PublicReviewSchema);
export type PublicReviewPage = z.infer<typeof PublicReviewPageSchema>;

/* ----------------------------------------------------------------------------------------
 * The caller's own review (student BFF, P review:write:own):
 *   GET    /me/courses/:courseId/review          -> 200 MyCourseReview  (403, 404)
 *   PUT    /me/courses/:courseId/review {rating, body?} -> 201 MyReview (new) / 200 (edited or
 *          unchanged) (403 enrollment_required | cannot_review_own_course, 422 review_not_eligible, 429)
 *   DELETE /me/courses/:courseId/review          -> 204 (404 review_not_found; a new review may follow)
 * -------------------------------------------------------------------------------------- */

/** `body: null` (or omitted) means a rating without text. */
export const UpsertReviewRequestSchema = z.object({
  rating: ReviewRatingSchema,
  body: ReviewBodySchema.nullable().optional(),
});
export type UpsertReviewRequest = z.output<typeof UpsertReviewRequestSchema>;

export const MyReviewSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  rating: ReviewRatingSchema,
  body: z.string().nullable(),
  /** HIDDEN: "hidden by moderation" banner; SUSPENDED: the enrollment was revoked (D9). */
  state: ReviewStateSchema,
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  reply: PublicReviewReplySchema.nullable(),
});
export type MyReview = z.infer<typeof MyReviewSchema>;

/** Why the caller cannot review right now (problem codes; null when eligible). */
export const REVIEW_BLOCK_REASONS = [
  ErrorCode.EnrollmentRequired,
  ErrorCode.CannotReviewOwnCourse,
  ErrorCode.ReviewNotEligible,
] as const;
export const ReviewBlockReasonSchema = z.enum(REVIEW_BLOCK_REASONS);
export type ReviewBlockReason = z.infer<typeof ReviewBlockReasonSchema>;

/** Drives the "Leave a rating" dialog: enabled once `canReview`. */
export const MyCourseReviewSchema = z
  .object({
    courseId: UuidSchema,
    review: MyReviewSchema.nullable(),
    canReview: z.boolean(),
    blockReason: ReviewBlockReasonSchema.nullable(),
  })
  .refine((s) => s.canReview === (s.blockReason === null), {
    message: 'blockReason is set exactly when canReview is false',
    path: ['blockReason'],
  });
export type MyCourseReview = z.infer<typeof MyCourseReviewSchema>;

/* ----------------------------------------------------------------------------------------
 * Instructor (instructor BFF, Pol course:engage):
 *   GET    /courses/:courseId/reviews?rating=&cursor=&limit= -> 200 InstructorReviewPage (404)
 *   PUT    /courses/:courseId/reviews/:reviewId/reply {body}  -> 200 ReviewReply (404 review_not_found, 429)
 *   DELETE /courses/:courseId/reviews/:reviewId/reply         -> 204 (404 reply_not_found)
 * Non-deleted reviews with their flags; the review must be PUBLISHED or HIDDEN to be replied to.
 * -------------------------------------------------------------------------------------- */

export const CourseReviewParamsSchema = z.object({ courseId: UuidSchema, reviewId: UuidSchema });
export type CourseReviewParams = z.output<typeof CourseReviewParamsSchema>;

export const InstructorReviewsQuerySchema = PublicReviewsQuerySchema;
export type InstructorReviewsQuery = PublicReviewsQuery;

export const UpsertReviewReplyRequestSchema = z.object({ body: ReviewReplyBodySchema });
export type UpsertReviewReplyRequest = z.output<typeof UpsertReviewReplyRequestSchema>;

export const ReviewReplySchema = z.object({
  reviewId: UuidSchema,
  body: z.string(),
  author: PersonRefSchema.nullable(),
  /** Hidden by moderation (the reply is not public). */
  hidden: z.boolean(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
});
export type ReviewReply = z.infer<typeof ReviewReplySchema>;

export const InstructorReviewSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  rating: ReviewRatingSchema,
  body: z.string().nullable(),
  author: PersonRefSchema.nullable(),
  state: ReviewStateSchema,
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  reply: ReviewReplySchema.nullable(),
});
export type InstructorReview = z.infer<typeof InstructorReviewSchema>;

export const InstructorReviewPageSchema = pageSchema(InstructorReviewSchema);
export type InstructorReviewPage = z.infer<typeof InstructorReviewPageSchema>;
