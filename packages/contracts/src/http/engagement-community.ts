import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { PersonRefSchema } from './catalog';
import { uuidListParam } from './commerce-common';
import { IsoDateTimeSchema, markdownText, singleLineText, UuidSchema } from './fields';
import { CompactPaginationQuerySchema, pageSchema } from './pagination';
import { ProblemDetailsSchema } from './problem-details';

/**
 * Announcements and the wishlist (Phase 5 learning experience design D18, D19, §5, §8).
 */

/* ----------------------------------------------------------------------------------------
 * Announcements (D18): immutable, soft delete, at most `perCourse` per course per
 * `windowDays` (deleted ones still count) and 20 per instructor per 24 h.
 *
 *   GET    /me/courses/:courseId/announcements?cursor=&limit= -> 200 AnnouncementPage
 *          (P learning:participate; 403, 404)
 *   GET    /courses/:courseId/announcements?cursor=&limit=    -> 200 InstructorAnnouncementPage
 *          (Pol course:engage; 404)
 *   POST   /courses/:courseId/announcements                   -> 201 Announcement
 *          (Pol course:engage; 404, 422 announcement_limit_exceeded | markdown_not_allowed, 429)
 *   DELETE /courses/:courseId/announcements/:announcementId   -> 204 (404 announcement_not_found)
 * Keyset (createdAt DESC, id DESC). The course must be PUBLISHED or ARCHIVED to post.
 * -------------------------------------------------------------------------------------- */

export const ANNOUNCEMENT_LIMITS = Object.freeze({
  perCourse: 4,
  windowDays: 30,
  titleMinChars: 5,
  titleMaxChars: 120,
  bodyMaxChars: 10_000,
});

export const AnnouncementTitleSchema = singleLineText(
  ANNOUNCEMENT_LIMITS.titleMinChars,
  ANNOUNCEMENT_LIMITS.titleMaxChars,
);
export const AnnouncementBodySchema = markdownText(1, ANNOUNCEMENT_LIMITS.bodyMaxChars);

export const AnnouncementParamsSchema = z.object({
  courseId: UuidSchema,
  announcementId: UuidSchema,
});
export type AnnouncementParams = z.output<typeof AnnouncementParamsSchema>;

export const AnnouncementsQuerySchema = CompactPaginationQuerySchema;
export type AnnouncementsQuery = z.output<typeof AnnouncementsQuerySchema>;

export const AnnouncementSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  title: z.string(),
  bodyMd: z.string(),
  /** Null when the author is banned. */
  author: PersonRefSchema.nullable(),
  /** Also e-mailed to enrolled students (per their preferences). */
  sendEmail: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const AnnouncementPageSchema = pageSchema(AnnouncementSchema);
export type AnnouncementPage = z.infer<typeof AnnouncementPageSchema>;

/** The course's posting quota (counted over the last `windowDays`, deleted posts included). */
export const AnnouncementQuotaSchema = z.object({
  limit: z.number().int().min(1),
  used: z.number().int().min(0),
  windowDays: z.number().int().min(1),
  /** When the oldest counted post leaves the window; null while `used < limit`. */
  nextAvailableAt: IsoDateTimeSchema.nullable(),
});
export type AnnouncementQuota = z.infer<typeof AnnouncementQuotaSchema>;

export const InstructorAnnouncementPageSchema = pageSchema(AnnouncementSchema).extend({
  quota: AnnouncementQuotaSchema,
});
export type InstructorAnnouncementPage = z.infer<typeof InstructorAnnouncementPageSchema>;

export const PostAnnouncementRequestSchema = z.object({
  title: AnnouncementTitleSchema,
  bodyMd: AnnouncementBodySchema,
  sendEmail: z.boolean().default(false),
});
export type PostAnnouncementRequest = z.output<typeof PostAnnouncementRequestSchema>;

/** 422 `announcement_limit_exceeded`: `retryAt` is when the next post is allowed. */
export const AnnouncementLimitProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.AnnouncementLimitExceeded),
  retryAt: IsoDateTimeSchema,
});
export type AnnouncementLimitProblem = z.infer<typeof AnnouncementLimitProblemSchema>;

/* ----------------------------------------------------------------------------------------
 * Wishlist (D19, private, P wishlist:manage:own):
 *   GET    /me/wishlist?cursor=&limit=         -> 200 WishlistPage, keyset (addedAt DESC, courseId DESC)
 *   PUT    /me/wishlist/:courseId              -> 204 (404, 409 course_not_wishlistable,
 *                                                      422 wishlist_full, 429; idempotent)
 *   DELETE /me/wishlist/:courseId              -> 204 (idempotent)
 *   GET    /me/wishlist/states?courseIds=a,b   -> 200 WishlistStatesResponse
 * Only PUBLISHED courses the caller neither owns nor is enrolled in can be added.
 * -------------------------------------------------------------------------------------- */

export const WISHLIST_LIMITS = Object.freeze({ maxItems: 1000, maxStateIds: 48 });

export const WishlistQuerySchema = CompactPaginationQuerySchema;
export type WishlistQuery = z.output<typeof WishlistQuerySchema>;

export const WishlistItemSchema = z.object({
  courseId: UuidSchema,
  slug: z.string(),
  /** Live title. */
  title: z.string(),
  instructor: PersonRefSchema.nullable(),
  hasThumbnail: z.boolean(),
  /** False once the course was archived (it stays listed so the user can remove it). */
  available: z.boolean(),
  addedAt: IsoDateTimeSchema,
});
export type WishlistItem = z.infer<typeof WishlistItemSchema>;

export const WishlistPageSchema = pageSchema(WishlistItemSchema);
export type WishlistPage = z.infer<typeof WishlistPageSchema>;

export const WishlistStatesQuerySchema = z.object({
  courseIds: uuidListParam(WISHLIST_LIMITS.maxStateIds),
});
export type WishlistStatesQuery = z.output<typeof WishlistStatesQuerySchema>;

export const WishlistStateSchema = z.object({ courseId: UuidSchema, wishlisted: z.boolean() });
export type WishlistState = z.infer<typeof WishlistStateSchema>;

export const WishlistStatesResponseSchema = z.object({ items: z.array(WishlistStateSchema) });
export type WishlistStatesResponse = z.infer<typeof WishlistStatesResponseSchema>;
