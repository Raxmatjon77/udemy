import { z } from 'zod';
import {
  CourseLanguageSchema,
  CourseLevelSchema,
  LectureTypeSchema,
  PersonRefSchema,
} from './catalog';
import { CategoryLeafSchema } from './categories';
import { IsoDateTimeSchema, SLUG_MAX_LENGTH, SLUG_PATTERN, UuidSchema } from './fields';
import { PublicProfileSchema } from './me';
import { emptyToUndefined, pageSchema, paginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * GET /catalog/courses?category=&level=&language=&q=&cursor=&limit= -> 200 CourseCardPage
 * Keyset (firstPublishedAt DESC, id DESC); everything comes from the live revision.
 * -------------------------------------------------------------------------------------- */

export const BROWSE_COURSES_PAGE_LIMIT_MAX = 48;
export const BROWSE_COURSES_PAGE_LIMIT_DEFAULT = 24;

/** A slug in a path or query: not lowercased (an uppercase slug is simply not found). */
const SlugParamSchema = z.string().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN, 'Invalid slug');

export const BrowseCoursesQuerySchema = paginationQuerySchema(
  BROWSE_COURSES_PAGE_LIMIT_MAX,
  BROWSE_COURSES_PAGE_LIMIT_DEFAULT,
).extend({
  /** Category slug; a depth-1 slug includes its children. */
  category: z.preprocess(emptyToUndefined, SlugParamSchema.optional()),
  level: z.preprocess(emptyToUndefined, CourseLevelSchema.optional()),
  language: z.preprocess(emptyToUndefined, CourseLanguageSchema.optional()),
  /** Title search (trigram); at least 3 characters. */
  q: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(100).optional()),
});
export type BrowseCoursesQuery = z.output<typeof BrowseCoursesQuerySchema>;

export const CourseCardSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  level: CourseLevelSchema.nullable(),
  language: CourseLanguageSchema.nullable(),
  category: CategoryLeafSchema.nullable(),
  /** Null when the instructor is banned or unknown. */
  instructor: PersonRefSchema.nullable(),
  lectureCount: z.number().int().min(0),
  videoSeconds: z.number().int().min(0),
  /** Thumbnail via the web app's stable image route `/media/course-thumbnail/{id}`. */
  publishedAt: IsoDateTimeSchema,
});
export type CourseCard = z.infer<typeof CourseCardSchema>;

export const CourseCardPageSchema = pageSchema(CourseCardSchema);
export type CourseCardPage = z.infer<typeof CourseCardPageSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /catalog/courses/by-slug/:slug -> 200 CourseLanding (404 `course_not_found`)
 * -------------------------------------------------------------------------------------- */

export const CourseSlugParamsSchema = z.object({ slug: SlugParamSchema });
export type CourseSlugParams = z.output<typeof CourseSlugParamsSchema>;

export const LandingLectureSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  type: LectureTypeSchema,
  /** VIDEO only (snapshotted at submit). */
  durationSeconds: z.number().int().min(0).nullable(),
  isPreview: z.boolean(),
});
export type LandingLecture = z.infer<typeof LandingLectureSchema>;

export const LandingSectionSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  objective: z.string().nullable(),
  lectures: z.array(LandingLectureSchema),
});
export type LandingSection = z.infer<typeof LandingSectionSchema>;

export const CourseLandingSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  /** The live revision the page was rendered from. */
  revisionId: UuidSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  descriptionMd: z.string().nullable(),
  language: CourseLanguageSchema.nullable(),
  level: CourseLevelSchema.nullable(),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
  /** Root first: `[group, leaf]`. */
  categoryPath: z.array(CategoryLeafSchema),
  /** Null when the instructor is banned or unknown. */
  instructor: PublicProfileSchema.nullable(),
  sections: z.array(LandingSectionSchema),
  totals: z.object({
    sectionCount: z.number().int().min(0),
    lectureCount: z.number().int().min(0),
    videoSeconds: z.number().int().min(0),
  }),
  publishedAt: IsoDateTimeSchema,
  /** When the live revision was approved. */
  lastUpdatedAt: IsoDateTimeSchema,
});
export type CourseLanding = z.infer<typeof CourseLandingSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /catalog/courses/:courseId/images/thumbnail?variant=w750|w480 -> 200 SignedUrl
 * -------------------------------------------------------------------------------------- */

export const THUMBNAIL_VARIANTS = ['w750', 'w480'] as const;
export const ThumbnailVariantSchema = z.enum(THUMBNAIL_VARIANTS);
export type ThumbnailVariant = z.infer<typeof ThumbnailVariantSchema>;

export const ThumbnailQuerySchema = z.object({
  variant: z.preprocess(emptyToUndefined, ThumbnailVariantSchema.default('w750')),
});
export type ThumbnailQuery = z.output<typeof ThumbnailQuerySchema>;

/* ----------------------------------------------------------------------------------------
 * Article: GET /catalog/courses/:courseId/lectures/:lectureId/article -> 200 PublicArticle
 * (also /admin/course-revisions/:revisionId/lectures/:lectureId/article)
 * -------------------------------------------------------------------------------------- */

/** Markdown source; render it with `@udemy/markdown` `<MarkdownView>` (sanitized). */
export const PublicArticleSchema = z.object({ bodyMd: z.string() });
export type PublicArticle = z.infer<typeof PublicArticleSchema>;

/* ----------------------------------------------------------------------------------------
 * HLS playback (design D7). These endpoints answer `text/plain`-like playlists, not JSON:
 *
 *   live (public, optional Bearer):
 *     GET /catalog/courses/:courseId/lectures/:lectureId/hls/master.m3u8
 *     GET /catalog/courses/:courseId/lectures/:lectureId/hls/:rendition.m3u8
 *   working copy (owner/admin):
 *     GET /courses/:courseId/lectures/:lectureId/preview/hls/master.m3u8
 *     GET /courses/:courseId/lectures/:lectureId/preview/hls/:rendition.m3u8
 *   revision (admin):
 *     GET /admin/course-revisions/:revisionId/lectures/:lectureId/hls/master.m3u8
 *     GET /admin/course-revisions/:revisionId/lectures/:lectureId/hls/:rendition.m3u8
 *
 * 200 `application/vnd.apple.mpegurl`, `Cache-Control: private, no-store`. The master's
 * variant URIs are relative (`720p.m3u8`), so they resolve back through the BFF proxy;
 * variant playlists carry presigned segment URLs (TTL 1 h; the player reloads on 403).
 * Errors (problem+json): 403 `lecture_locked`, 404, 409 `media_not_ready`, 429.
 * -------------------------------------------------------------------------------------- */

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
export const HLS_MASTER_PLAYLIST_NAME = 'master.m3u8';

/** HLS variant names (`:rendition` without `.m3u8`); validated again against DB rows. */
export const HLS_RENDITION_PATTERN = /^(?:360p|480p|720p|1080p|src\d{3,4}p)$/;
export const HlsRenditionSchema = z
  .string()
  .regex(HLS_RENDITION_PATTERN, 'Unknown rendition')
  .meta({ examples: ['720p'] });

/** Master playlist of a live or working-copy lecture. */
export const LecturePlaylistParamsSchema = z.object({
  courseId: UuidSchema,
  lectureId: UuidSchema,
});
export type LecturePlaylistParams = z.output<typeof LecturePlaylistParamsSchema>;

/** Variant playlist of a live or working-copy lecture. */
export const LectureVariantPlaylistParamsSchema = LecturePlaylistParamsSchema.extend({
  rendition: HlsRenditionSchema,
});
export type LectureVariantPlaylistParams = z.output<typeof LectureVariantPlaylistParamsSchema>;

/** Master playlist of a lecture inside a revision under review. */
export const RevisionLecturePlaylistParamsSchema = z.object({
  revisionId: UuidSchema,
  lectureId: UuidSchema,
});
export type RevisionLecturePlaylistParams = z.output<typeof RevisionLecturePlaylistParamsSchema>;

export const RevisionLectureVariantPlaylistParamsSchema =
  RevisionLecturePlaylistParamsSchema.extend({ rendition: HlsRenditionSchema });
export type RevisionLectureVariantPlaylistParams = z.output<
  typeof RevisionLectureVariantPlaylistParamsSchema
>;
