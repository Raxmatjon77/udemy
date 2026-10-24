import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import {
  ArticleBodySchema,
  CourseBadgeSchema,
  CourseBulletListSchema,
  CourseDescriptionSchema,
  CourseLanguageSchema,
  CourseLevelSchema,
  CourseStatusSchema,
  CourseSubtitleSchema,
  CourseTitleSchema,
  CourseTransitionActionSchema,
  CURRICULUM_LIMITS,
  LectureDescriptionSchema,
  LectureTitleSchema,
  LectureTypeSchema,
  RevisionKindSchema,
  SectionObjectiveSchema,
  SectionTitleSchema,
  SubmitNoteSchema,
  TransitionNoteSchema,
} from './catalog';
import { ThumbnailQuerySchema } from './catalog-public';
import { LectureQuizSummarySchema } from './quiz';
import { ExpectedVersionSchema, IsoDateTimeSchema, SlugSchema, UuidSchema } from './fields';
import { AssetViewSchema, SignedUrlSchema } from './media';
import { emptyToUndefined, pageSchema, paginationQuerySchema } from './pagination';
import { ProblemDetailsSchema } from './problem-details';

/* ----------------------------------------------------------------------------------------
 * Readiness (design §4 invariant 6) — every issue is returned at once
 * -------------------------------------------------------------------------------------- */

export const COURSE_READINESS_ISSUE_CODES = [
  'SUBTITLE_MISSING',
  'DESCRIPTION_TOO_SHORT',
  'LANGUAGE_MISSING',
  'LEVEL_MISSING',
  'CATEGORY_MISSING',
  'CATEGORY_INACTIVE',
  'THUMBNAIL_MISSING',
  'THUMBNAIL_NOT_READY',
  'TOO_FEW_OUTCOMES',
  'NO_SECTIONS',
  'SECTION_EMPTY',
  'TOO_FEW_LECTURES',
  'NOT_ENOUGH_VIDEO',
  'LECTURE_MEDIA_MISSING',
  'LECTURE_MEDIA_NOT_READY',
  'ARTICLE_TOO_SHORT',
  // Phase 5 (design §5): a QUIZ lecture without questions; a question with too few options or
  // the wrong number of correct options (SINGLE exactly one, MULTIPLE at least one).
  'QUIZ_EMPTY',
  'QUIZ_QUESTION_INVALID',
] as const;
export const CourseReadinessIssueCodeSchema = z.enum(COURSE_READINESS_ISSUE_CODES);
export type CourseReadinessIssueCode = z.infer<typeof CourseReadinessIssueCodeSchema>;

/**
 * One unmet requirement. `sectionId`/`lectureId` point at the offending item (null for
 * course-level issues); `required`/`actual` carry the numbers for count and length rules
 * (e.g. TOO_FEW_LECTURES: required 5, actual 3), otherwise null.
 */
export const CourseReadinessIssueSchema = z.object({
  code: CourseReadinessIssueCodeSchema,
  sectionId: UuidSchema.nullable(),
  lectureId: UuidSchema.nullable(),
  required: z.number().int().min(0).nullable(),
  actual: z.number().int().min(0).nullable(),
});
export type CourseReadinessIssue = z.infer<typeof CourseReadinessIssueSchema>;

export const CourseReadinessSchema = z.object({
  ready: z.boolean(),
  issues: z.array(CourseReadinessIssueSchema),
});
export type CourseReadiness = z.infer<typeof CourseReadinessSchema>;

/** 422 `course_not_ready` on submit. */
export const CourseNotReadyProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.CourseNotReady),
  issues: z.array(CourseReadinessIssueSchema).min(1),
});
export type CourseNotReadyProblem = z.infer<typeof CourseNotReadyProblemSchema>;

/* ----------------------------------------------------------------------------------------
 * CourseDetail (GET/PATCH /courses/:courseId and every lifecycle action)
 * -------------------------------------------------------------------------------------- */

export const RevisionSummarySchema = z.object({
  id: UuidSchema,
  revisionNo: z.number().int().min(1),
  kind: RevisionKindSchema,
  submittedAt: IsoDateTimeSchema,
});
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;

/** The most recent APPROVE or REJECT; the rejection reason is shown prominently. */
export const CourseDecisionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  revisionId: UuidSchema,
  revisionNo: z.number().int().min(1),
  /** Rejection reason or approval note. */
  reason: z.string().nullable(),
  decidedAt: IsoDateTimeSchema,
});
export type CourseDecision = z.infer<typeof CourseDecisionSchema>;

export const CourseDetailSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  slug: z.string(),
  /** False once the course was first published (`slug_frozen`). */
  slugEditable: z.boolean(),
  title: z.string(),
  subtitle: z.string().nullable(),
  descriptionMd: z.string().nullable(),
  language: CourseLanguageSchema.nullable(),
  level: CourseLevelSchema.nullable(),
  categoryId: UuidSchema.nullable(),
  thumbnailAssetId: UuidSchema.nullable(),
  thumbnail: AssetViewSchema.nullable(),
  outcomes: z.array(z.string()),
  requirements: z.array(z.string()),
  status: CourseStatusSchema,
  badge: CourseBadgeSchema,
  /** Optimistic-lock version; send it back as `expectedVersion`. */
  version: z.number().int().min(1),
  /** True while a revision is pending: the working copy is read-only (D2). */
  locked: z.boolean(),
  pendingRevision: RevisionSummarySchema.nullable(),
  liveRevision: RevisionSummarySchema.nullable(),
  latestDecision: CourseDecisionSchema.nullable(),
  readiness: CourseReadinessSchema,
  /** The working copy differs from the live revision (content hash). */
  hasUnpublishedChanges: z.boolean(),
  firstPublishedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CourseDetail = z.infer<typeof CourseDetailSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /instructor/courses?status=&cursor=&limit= -> 200 page, (updatedAt DESC, id DESC)
 * -------------------------------------------------------------------------------------- */

export const MY_COURSES_PAGE_LIMIT_MAX = 50;

export const MyCoursesQuerySchema = paginationQuerySchema(MY_COURSES_PAGE_LIMIT_MAX, 20).extend({
  status: z.preprocess(emptyToUndefined, CourseStatusSchema.optional()),
});
export type MyCoursesQuery = z.output<typeof MyCoursesQuerySchema>;

export const MyCourseRowSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  status: CourseStatusSchema,
  badge: CourseBadgeSchema,
  thumbnailAssetId: UuidSchema.nullable(),
  firstPublishedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type MyCourseRow = z.infer<typeof MyCourseRowSchema>;

export const MyCoursePageSchema = pageSchema(MyCourseRowSchema);
export type MyCoursePage = z.infer<typeof MyCoursePageSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /instructor/courses -> 201 CourseDetail + Location
 * -------------------------------------------------------------------------------------- */

export const CreateCourseRequestSchema = z.object({
  title: CourseTitleSchema,
  /** An active depth-2 category, else 422 `category_inactive` / `category_not_leaf`. */
  categoryId: UuidSchema.optional(),
});
export type CreateCourseRequest = z.output<typeof CreateCourseRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * PATCH /courses/:courseId -> 200 CourseDetail
 * -------------------------------------------------------------------------------------- */

/**
 * Partial update; at least one field besides `expectedVersion`. `null` clears an optional
 * field. `outcomes`/`requirements` replace the whole list (≤ 10 lines of 1–160 chars).
 */
export const UpdateCourseRequestSchema = z
  .object({
    title: CourseTitleSchema.optional(),
    subtitle: CourseSubtitleSchema.nullable().optional(),
    descriptionMd: CourseDescriptionSchema.nullable().optional(),
    language: CourseLanguageSchema.nullable().optional(),
    level: CourseLevelSchema.nullable().optional(),
    categoryId: UuidSchema.nullable().optional(),
    /** Editable until the first publication, then 409 `slug_frozen`. */
    slug: SlugSchema.optional(),
    outcomes: CourseBulletListSchema.optional(),
    requirements: CourseBulletListSchema.optional(),
    expectedVersion: ExpectedVersionSchema.optional(),
  })
  .refine(
    ({ expectedVersion: _ignored, ...fields }) =>
      Object.values(fields).some((value) => value !== undefined),
    { message: 'At least one course field is required' },
  )
  .meta({ minProperties: 1 });
export type UpdateCourseRequest = z.output<typeof UpdateCourseRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * PUT /courses/:courseId/thumbnail -> 200 CourseDetail;  DELETE -> 200 CourseDetail
 * PUT /courses/:courseId/lectures/:lectureId/media -> 200 Lecture;  DELETE -> 200 Lecture
 * -------------------------------------------------------------------------------------- */

/** A COURSE_THUMBNAIL / LECTURE_VIDEO / LECTURE_RESOURCE asset owned by the course owner. */
export const AttachAssetRequestSchema = z.object({ assetId: UuidSchema });
export type AttachAssetRequest = z.output<typeof AttachAssetRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /courses/:courseId/thumbnail?variant=w750|w480 -> 200 SignedUrl (owner / admin)
 * The WORKING-COPY thumbnail for the builder (the public route only serves the live
 * revision). Params: `CourseIdParamsSchema`. Errors: 404 `course_not_found` (also when no
 * thumbnail is attached), 409 `media_not_ready` (attached but not READY: show the AssetView
 * status from `CourseDetail.thumbnail` instead). The URL is a bearer capability: never log it.
 * -------------------------------------------------------------------------------------- */

export const CourseThumbnailQuerySchema = ThumbnailQuerySchema;
export type CourseThumbnailQuery = z.output<typeof CourseThumbnailQuerySchema>;

export const CourseThumbnailResponseSchema = SignedUrlSchema;
export type CourseThumbnailResponse = z.infer<typeof CourseThumbnailResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /courses/:courseId/lectures/:lectureId/download -> 200 SignedUrl (RESOURCE lecture of
 * the working copy; owner / admin). Params: `LectureParamsSchema`. Errors: 404, 409
 * `media_not_ready`.
 * -------------------------------------------------------------------------------------- */

export const LectureDownloadResponseSchema = SignedUrlSchema;
export type LectureDownloadResponse = z.infer<typeof LectureDownloadResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * 422 `markdown_not_allowed` (any markdown field: descriptions, article body)
 * -------------------------------------------------------------------------------------- */

/** Mirrors `@udemy/markdown/validate` `MARKDOWN_ISSUE_KINDS` (kept equal by its test). */
export const MARKDOWN_ISSUE_KINDS = [
  'raw_html',
  'image',
  'unsafe_link',
  'disallowed_link',
  'too_deeply_nested',
  'too_complex',
  'unsupported_syntax',
] as const;
export const MarkdownIssueKindSchema = z.enum(MARKDOWN_ISSUE_KINDS);
export type MarkdownIssueKind = z.infer<typeof MarkdownIssueKindSchema>;

/** Mirrors `@udemy/markdown/validate` `MarkdownConstruct` (kept equal by its test). */
export const MARKDOWN_CONSTRUCTS = [
  'html_block',
  'html_inline',
  'image',
  'image_reference',
  'link',
  'autolink',
  'literal_autolink',
  'definition',
  'document',
  'other',
] as const;
export const MarkdownConstructSchema = z.enum(MARKDOWN_CONSTRUCTS);
export type MarkdownConstruct = z.infer<typeof MarkdownConstructSchema>;

/** One offending construct; `line`/`column` are 1-based positions in that field's source. */
export const MarkdownIssueSchema = z.object({
  /** Dotted request path of the markdown field (`descriptionMd`, `bodyMd`). */
  path: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  kind: MarkdownIssueKindSchema,
  construct: MarkdownConstructSchema,
  /** Plain text, safe to show to the author. */
  detail: z.string(),
});
export type MarkdownIssue = z.infer<typeof MarkdownIssueSchema>;

/**
 * 422 `markdown_not_allowed`: raw HTML, images or links other than absolute http(s)/mailto
 * (design D14), or markdown too complex to process. `issues` is the structured form of
 * `errors` (which keeps one `{ path, message }` per issue for generic clients).
 */
export const MarkdownNotAllowedProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.MarkdownNotAllowed),
  issues: z.array(MarkdownIssueSchema).min(1),
});
export type MarkdownNotAllowedProblem = z.infer<typeof MarkdownNotAllowedProblemSchema>;

/* ----------------------------------------------------------------------------------------
 * Curriculum: GET /courses/:courseId/curriculum -> 200 Curriculum
 * -------------------------------------------------------------------------------------- */

export const LectureSchema = z.object({
  id: UuidSchema,
  sectionId: UuidSchema,
  type: LectureTypeSchema,
  title: z.string(),
  descriptionMd: z.string().nullable(),
  isPreview: z.boolean(),
  /** 0-based, contiguous within the section. */
  position: z.number().int().min(0),
  mediaAssetId: UuidSchema.nullable(),
  /** Fresh asset state (status, progress, duration); null without media or for ARTICLE. */
  asset: AssetViewSchema.nullable(),
  /** ARTICLE lectures: plain length of the body (readiness needs ≥ 50); else null. */
  articleLength: z.number().int().min(0).nullable(),
  /**
   * QUIZ lectures: the working-copy settings (Phase 5, additive); null for other types.
   * Optional until the api fills it (P5-T6); the full quiz is `GET …/lectures/:lectureId/quiz`.
   */
  quiz: LectureQuizSummarySchema.nullable().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type Lecture = z.infer<typeof LectureSchema>;

export const SectionSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  objective: z.string().nullable(),
  position: z.number().int().min(0),
  updatedAt: IsoDateTimeSchema,
});
export type Section = z.infer<typeof SectionSchema>;

export const CurriculumSectionSchema = SectionSchema.extend({
  lectures: z.array(LectureSchema),
});
export type CurriculumSection = z.infer<typeof CurriculumSectionSchema>;

export const CurriculumSchema = z.object({
  courseId: UuidSchema,
  /** Course version after the last write (curriculum writes bump it). */
  version: z.number().int().min(1),
  locked: z.boolean(),
  sections: z.array(CurriculumSectionSchema),
  totals: z.object({
    sectionCount: z.number().int().min(0),
    lectureCount: z.number().int().min(0),
    previewCount: z.number().int().min(0),
    videoSeconds: z.number().int().min(0),
  }),
});
export type Curriculum = z.infer<typeof CurriculumSchema>;

/* ----------------------------------------------------------------------------------------
 * Sections: POST /courses/:courseId/sections -> 201 Section
 *           PATCH /courses/:courseId/sections/:sectionId -> 200 Section;  DELETE -> 204
 * -------------------------------------------------------------------------------------- */

export const CreateSectionRequestSchema = z.object({
  title: SectionTitleSchema,
  objective: SectionObjectiveSchema.optional(),
});
export type CreateSectionRequest = z.output<typeof CreateSectionRequestSchema>;

export const UpdateSectionRequestSchema = z
  .object({
    title: SectionTitleSchema.optional(),
    objective: SectionObjectiveSchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of title or objective is required',
  })
  .meta({ minProperties: 1 });
export type UpdateSectionRequest = z.output<typeof UpdateSectionRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * Lectures: POST /courses/:courseId/sections/:sectionId/lectures -> 201 Lecture
 *           PATCH /courses/:courseId/lectures/:lectureId -> 200 Lecture;  DELETE -> 204
 * -------------------------------------------------------------------------------------- */

/** The type is immutable after creation. */
export const CreateLectureRequestSchema = z.object({
  type: LectureTypeSchema,
  title: LectureTitleSchema,
});
export type CreateLectureRequest = z.output<typeof CreateLectureRequestSchema>;

/** `isPreview` only for VIDEO/ARTICLE, ≤ 10 per course (422 `preview_not_allowed`). */
export const UpdateLectureRequestSchema = z
  .object({
    title: LectureTitleSchema.optional(),
    descriptionMd: LectureDescriptionSchema.nullable().optional(),
    isPreview: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of title, descriptionMd or isPreview is required',
  })
  .meta({ minProperties: 1 });
export type UpdateLectureRequest = z.output<typeof UpdateLectureRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET / PUT /courses/:courseId/lectures/:lectureId/article -> 200 Article
 * -------------------------------------------------------------------------------------- */

export const SaveArticleRequestSchema = z.object({ bodyMd: ArticleBodySchema });
export type SaveArticleRequest = z.output<typeof SaveArticleRequestSchema>;

export const ArticleSchema = z.object({
  lectureId: UuidSchema,
  bodyMd: z.string(),
  /** Null when the article was never saved (empty body). */
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type Article = z.infer<typeof ArticleSchema>;

/* ----------------------------------------------------------------------------------------
 * PUT /courses/:courseId/curriculum/order -> 200 Curriculum
 * -------------------------------------------------------------------------------------- */

/**
 * The whole curriculum order (design D3): every section once, every lecture once, lectures
 * may move between sections. The server requires an exact permutation of the current ids
 * (409 `order_mismatch`); duplicates and size violations are rejected here already.
 */
export const ReorderCurriculumRequestSchema = z
  .object({
    sections: z
      .array(
        z.object({
          sectionId: UuidSchema,
          lectureIds: z.array(UuidSchema).max(CURRICULUM_LIMITS.maxLecturesPerSection),
        }),
      )
      .max(CURRICULUM_LIMITS.maxSectionsPerCourse),
  })
  .superRefine(({ sections }, ctx) => {
    const sectionIds = new Set(sections.map((s) => s.sectionId));
    if (sectionIds.size !== sections.length) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Section ids must be unique' });
    }
    const lectureIds = sections.flatMap((s) => s.lectureIds);
    if (lectureIds.length > CURRICULUM_LIMITS.maxLecturesPerCourse) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `At most ${CURRICULUM_LIMITS.maxLecturesPerCourse} lectures per course`,
      });
    }
    if (new Set(lectureIds).size !== lectureIds.length) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Lecture ids must be unique' });
    }
  });
export type ReorderCurriculumRequest = z.output<typeof ReorderCurriculumRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * Lifecycle
 *   POST /courses/:courseId/submit   -> 200 SubmitCourseResponse
 *   POST /courses/:courseId/withdraw -> 200 CourseDetail
 *   POST /courses/:courseId/archive  -> 200 CourseDetail
 *   POST /courses/:courseId/restore  -> 200 CourseDetail
 *   DELETE /courses/:courseId        -> 204
 * -------------------------------------------------------------------------------------- */

export const SubmitCourseRequestSchema = z.object({ note: SubmitNoteSchema.optional() });
export type SubmitCourseRequest = z.output<typeof SubmitCourseRequestSchema>;

export const SubmitCourseResponseSchema = z.object({
  revisionId: UuidSchema,
  revisionNo: z.number().int().min(1),
});
export type SubmitCourseResponse = z.infer<typeof SubmitCourseResponseSchema>;

/** Owner archive: the reason is optional (an admin takedown requires one). */
export const ArchiveCourseRequestSchema = z.object({ reason: TransitionNoteSchema.optional() });
export type ArchiveCourseRequest = z.output<typeof ArchiveCourseRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /courses/:courseId/history -> 200 CourseHistoryResponse (oldest first)
 * -------------------------------------------------------------------------------------- */

export const CourseHistoryActorSchema = z.object({
  /** Null when hidden: instructors see admins only as "Moderator". */
  id: UuidSchema.nullable(),
  displayName: z.string(),
  isModerator: z.boolean(),
});
export type CourseHistoryActor = z.infer<typeof CourseHistoryActorSchema>;

export const CourseTransitionSchema = z.object({
  id: UuidSchema,
  action: CourseTransitionActionSchema,
  fromStatus: CourseStatusSchema.nullable(),
  toStatus: CourseStatusSchema,
  revisionId: UuidSchema.nullable(),
  revisionNo: z.number().int().min(1).nullable(),
  actor: CourseHistoryActorSchema,
  /** Reject reason, approval note, archive/takedown reason, or `ARCHIVED` on auto-withdraw. */
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type CourseTransition = z.infer<typeof CourseTransitionSchema>;

export const CourseHistoryResponseSchema = z.object({ items: z.array(CourseTransitionSchema) });
export type CourseHistoryResponse = z.infer<typeof CourseHistoryResponseSchema>;
