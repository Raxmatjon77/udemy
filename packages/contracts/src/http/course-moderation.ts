import { z } from 'zod';
import {
  CourseBadgeSchema,
  CourseLanguageSchema,
  CourseLevelSchema,
  CourseStatusSchema,
  LectureTypeSchema,
  ModerationReasonSchema,
  PersonRefSchema,
  RevisionKindSchema,
  RevisionStateSchema,
  TransitionNoteSchema,
} from './catalog';
import { ThumbnailQuerySchema } from './catalog-public';
import { CategoryLeafSchema } from './categories';
import { CourseHistoryActorSchema } from './courses';
import { ExpectedVersionSchema, IsoDateTimeSchema, UuidSchema } from './fields';
import { AssetViewSchema, SignedUrlSchema } from './media';
import { emptyToUndefined, pageSchema, PaginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * GET /admin/course-reviews?cursor=&limit= -> 200 page, oldest first
 * Keyset (submittedAt, revisionId).
 * -------------------------------------------------------------------------------------- */

export const ReviewQueueQuerySchema = PaginationQuerySchema;
export type ReviewQueueQuery = z.output<typeof ReviewQueueQuerySchema>;

export const ReviewQueueItemSchema = z.object({
  courseId: UuidSchema,
  revisionId: UuidSchema,
  revisionNo: z.number().int().min(1),
  kind: RevisionKindSchema,
  title: z.string(),
  owner: PersonRefSchema,
  submittedAt: IsoDateTimeSchema,
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueuePageSchema = pageSchema(ReviewQueueItemSchema);
export type ReviewQueuePage = z.infer<typeof ReviewQueuePageSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/course-revisions/:revisionId -> 200 RevisionReview
 * The full immutable snapshot + a diff against the live revision + asset views.
 * -------------------------------------------------------------------------------------- */

export const RevisionLectureSchema = z.object({
  id: UuidSchema,
  sectionId: UuidSchema,
  position: z.number().int().min(0),
  type: LectureTypeSchema,
  title: z.string(),
  descriptionMd: z.string().nullable(),
  isPreview: z.boolean(),
  mediaAssetId: UuidSchema.nullable(),
  durationSeconds: z.number().int().min(0).nullable(),
  /** ARTICLE only. */
  articleBodyMd: z.string().nullable(),
});
export type RevisionLecture = z.infer<typeof RevisionLectureSchema>;

export const RevisionSectionSchema = z.object({
  id: UuidSchema,
  position: z.number().int().min(0),
  title: z.string(),
  objective: z.string().nullable(),
  lectures: z.array(RevisionLectureSchema),
});
export type RevisionSection = z.infer<typeof RevisionSectionSchema>;

/** The snapshot's depth-2 category, with its depth-1 group when known (optional, added later). */
export const RevisionCategorySchema = CategoryLeafSchema.extend({
  parent: CategoryLeafSchema.optional(),
});
export type RevisionCategory = z.infer<typeof RevisionCategorySchema>;

export const RevisionSnapshotSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  revisionNo: z.number().int().min(1),
  kind: RevisionKindSchema,
  state: RevisionStateSchema,
  /** SHA-256 of the canonical snapshot, lowercase hex. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  subtitle: z.string().nullable(),
  descriptionMd: z.string().nullable(),
  language: CourseLanguageSchema.nullable(),
  level: CourseLevelSchema.nullable(),
  category: RevisionCategorySchema.nullable(),
  thumbnailAssetId: UuidSchema.nullable(),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
  sections: z.array(RevisionSectionSchema),
  submittedBy: PersonRefSchema,
  submitterNote: z.string().nullable(),
  submittedAt: IsoDateTimeSchema,
});
export type RevisionSnapshot = z.infer<typeof RevisionSnapshotSchema>;

/** Header fields compared by the diff. */
export const REVISION_DIFF_FIELDS = [
  'title',
  'subtitle',
  'descriptionMd',
  'language',
  'level',
  'categoryId',
  'thumbnailAssetId',
  'outcomes',
  'requirements',
] as const;
export const RevisionDiffFieldSchema = z.enum(REVISION_DIFF_FIELDS);
export type RevisionDiffField = z.infer<typeof RevisionDiffFieldSchema>;

/** Removed items are not in the snapshot, so the diff carries their titles. */
const RemovedSectionSchema = z.object({ id: UuidSchema, title: z.string() });
const RemovedLectureSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  type: LectureTypeSchema,
  /** The section the lecture was in (in the base revision). Optional (added later). */
  sectionId: UuidSchema.optional(),
  sectionTitle: z.string().optional(),
});

/**
 * A diff value: text, enum and id fields are strings (`categoryId` is the id), bullet lists
 * (`outcomes`, `requirements`) are string arrays, an unset field is null.
 */
export const RevisionDiffValueSchema = z.union([z.string(), z.array(z.string())]).nullable();
export type RevisionDiffValue = z.infer<typeof RevisionDiffValueSchema>;

/** One changed header field with its live (`before`) and submitted (`after`) values. */
export const RevisionFieldChangeSchema = z.object({
  field: RevisionDiffFieldSchema,
  /** Null for an INITIAL revision (no live revision). */
  before: RevisionDiffValueSchema,
  after: RevisionDiffValueSchema,
});
export type RevisionFieldChange = z.infer<typeof RevisionFieldChangeSchema>;

/**
 * Diff of the snapshot against the live revision, by stable section/lecture id. `changed`
 * = content differs (title, description, preview flag, media, article); `moved` =
 * position or section differs. One id may be both changed and moved. For an INITIAL
 * revision (no live revision) `baseRevisionId` is null and everything is `added`.
 */
export const RevisionDiffSchema = z.object({
  baseRevisionId: UuidSchema.nullable(),
  changedFields: z.array(RevisionDiffFieldSchema),
  /**
   * Before/after values of every `changedFields` entry, in the same order. Optional (added
   * later): absent means only the field names are known.
   */
  fieldChanges: z.array(RevisionFieldChangeSchema).optional(),
  sections: z.object({
    added: z.array(UuidSchema),
    removed: z.array(RemovedSectionSchema),
    changed: z.array(UuidSchema),
    moved: z.array(UuidSchema),
  }),
  lectures: z.object({
    added: z.array(UuidSchema),
    removed: z.array(RemovedLectureSchema),
    changed: z.array(UuidSchema),
    moved: z.array(UuidSchema),
  }),
});
export type RevisionDiff = z.infer<typeof RevisionDiffSchema>;

export const RevisionReviewSchema = z.object({
  course: z.object({
    id: UuidSchema,
    slug: z.string(),
    status: CourseStatusSchema,
    version: z.number().int().min(1),
    owner: PersonRefSchema,
    pendingRevisionId: UuidSchema.nullable(),
    liveRevisionId: UuidSchema.nullable(),
  }),
  revision: RevisionSnapshotSchema,
  diff: RevisionDiffSchema,
  /** Every asset the snapshot references (thumbnail and lecture media). */
  assets: z.array(AssetViewSchema),
});
export type RevisionReview = z.infer<typeof RevisionReviewSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/courses/:courseId/revisions/:revisionId/approve -> 200 CourseDetail
 * POST /admin/courses/:courseId/revisions/:revisionId/reject  -> 200 CourseDetail
 * -------------------------------------------------------------------------------------- */

export const ApproveRevisionRequestSchema = z.object({
  note: TransitionNoteSchema.optional(),
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type ApproveRevisionRequest = z.output<typeof ApproveRevisionRequestSchema>;

/** The reason (10–2000) is mailed to the instructor. */
export const RejectRevisionRequestSchema = z.object({
  reason: ModerationReasonSchema,
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type RejectRevisionRequest = z.output<typeof RejectRevisionRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/courses?status=&q=&ownerId=&cursor=&limit= -> 200 page (updatedAt DESC)
 * -------------------------------------------------------------------------------------- */

export const AdminCoursesQuerySchema = PaginationQuerySchema.extend({
  status: z.preprocess(emptyToUndefined, CourseStatusSchema.optional()),
  /** Title or slug search; at least 3 characters (trigram). */
  q: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(100).optional()),
  ownerId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
});
export type AdminCoursesQuery = z.output<typeof AdminCoursesQuerySchema>;

export const AdminCourseRowSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  status: CourseStatusSchema,
  badge: CourseBadgeSchema,
  owner: PersonRefSchema.extend({
    /** Manual takedown is the Phase 2 policy for banned instructors (§13 Q4). */
    banned: z.boolean(),
  }),
  pendingRevisionId: UuidSchema.nullable(),
  liveRevisionId: UuidSchema.nullable(),
  firstPublishedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  /**
   * ARCHIVED courses: who archived it (the owner, or a moderator's takedown) and why, from the
   * latest ARCHIVE transition. Optional (added later); null when not archived.
   */
  archivedBy: CourseHistoryActorSchema.nullable().optional(),
  archiveReason: z.string().nullable().optional(),
});
export type AdminCourseRow = z.infer<typeof AdminCourseRowSchema>;

export const AdminCoursePageSchema = pageSchema(AdminCourseRowSchema);
export type AdminCoursePage = z.infer<typeof AdminCoursePageSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/courses/:courseId/takedown -> 200 CourseDetail
 * POST /admin/courses/:courseId/restore  -> 200 CourseDetail
 * -------------------------------------------------------------------------------------- */

/** The reason (10–2000) is mailed to the instructor. */
export const TakedownCourseRequestSchema = z.object({ reason: ModerationReasonSchema });
export type TakedownCourseRequest = z.output<typeof TakedownCourseRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * Admin review media (signed URLs; bearer capabilities, never log them):
 *
 *   GET /admin/course-revisions/:revisionId/thumbnail?variant=w750|w480 -> 200 SignedUrl
 *       Params `RevisionIdParamsSchema`. The revision's snapshotted thumbnail (pinned, so it
 *       survives working-copy edits). 404 `course_not_found` (no thumbnail), 409
 *       `media_not_ready`.
 *   GET /admin/course-revisions/:revisionId/lectures/:lectureId/download -> 200 SignedUrl
 *       Params `RevisionLectureParamsSchema`. A RESOURCE lecture's file in that revision.
 *       404, 409 `media_not_ready`.
 *
 * Permission: `course:read:any` (like the revision playlists and article).
 * -------------------------------------------------------------------------------------- */

export const RevisionThumbnailQuerySchema = ThumbnailQuerySchema;
export type RevisionThumbnailQuery = z.output<typeof RevisionThumbnailQuerySchema>;

export const RevisionThumbnailResponseSchema = SignedUrlSchema;
export type RevisionThumbnailResponse = z.infer<typeof RevisionThumbnailResponseSchema>;

export const RevisionLectureDownloadResponseSchema = SignedUrlSchema;
export type RevisionLectureDownloadResponse = z.infer<typeof RevisionLectureDownloadResponseSchema>;
