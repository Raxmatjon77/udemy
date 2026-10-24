import { z } from 'zod';
import { markdownText, multilineText, singleLineText, UuidSchema } from './fields';
import type { MediaPurpose } from './media';

/**
 * Catalog constants and value-object field schemas (design §4, §6). The lengths mirror the
 * `catalog.*` CHECK constraints; the api's domain VOs stay authoritative.
 */

/* ----------------------------------------------------------------------------------------
 * Enums
 * -------------------------------------------------------------------------------------- */

export const COURSE_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'EXPERT', 'ALL_LEVELS'] as const;
export const CourseLevelSchema = z.enum(COURSE_LEVELS);
export type CourseLevel = z.infer<typeof CourseLevelSchema>;

export const COURSE_LEVEL_LABELS: Readonly<Record<CourseLevel, string>> = Object.freeze({
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  EXPERT: 'Expert',
  ALL_LEVELS: 'All levels',
});

/**
 * Course language allowlist (BCP 47, `^[a-z]{2,3}(-[A-Z]{2})?$` like the DB CHECK).
 * Extending it is a contracts change only; the DB accepts any tag of that shape.
 */
export const COURSE_LANGUAGES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'kk',
  'ko',
  'ky',
  'nl',
  'pl',
  'pt',
  'pt-BR',
  'ru',
  'tg',
  'tr',
  'uk',
  'uz',
  'vi',
  'zh',
] as const;
export const CourseLanguageSchema = z.enum(COURSE_LANGUAGES);
export type CourseLanguage = z.infer<typeof CourseLanguageSchema>;

/** Endonyms, for language pickers and filters. */
export const COURSE_LANGUAGE_LABELS: Readonly<Record<CourseLanguage, string>> = Object.freeze({
  ar: 'العربية',
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  kk: 'Қазақ тілі',
  ko: '한국어',
  ky: 'Кыргызча',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  tg: 'Тоҷикӣ',
  tr: 'Türkçe',
  uk: 'Українська',
  uz: 'Oʻzbekcha',
  vi: 'Tiếng Việt',
  zh: '中文',
});

export const COURSE_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED', 'ARCHIVED'] as const;
export const CourseStatusSchema = z.enum(COURSE_STATUSES);
export type CourseStatus = z.infer<typeof CourseStatusSchema>;

/**
 * Derived "My courses" badge (design §5 `ListMyCourses`): the status combined with the
 * pending/live revision pointers and the latest decision.
 */
export const COURSE_BADGES = [
  'DRAFT',
  'IN_REVIEW',
  'REJECTED',
  'LIVE',
  'LIVE_UPDATE_PENDING',
  'LIVE_UPDATE_REJECTED',
  'ARCHIVED',
] as const;
export const CourseBadgeSchema = z.enum(COURSE_BADGES);
export type CourseBadge = z.infer<typeof CourseBadgeSchema>;

/**
 * Phase 5 (learning experience design D6) adds QUIZ: a lecture whose questions are authored in
 * the working copy and snapshotted into revisions like articles. QUIZ lectures have no media and
 * can never be a free preview.
 */
export const LECTURE_TYPES = ['VIDEO', 'ARTICLE', 'RESOURCE', 'QUIZ'] as const;
export const LectureTypeSchema = z.enum(LECTURE_TYPES);
export type LectureType = z.infer<typeof LectureTypeSchema>;

/** Media purpose a lecture type accepts (invariant 3); ARTICLE and QUIZ lectures have no media. */
export const LECTURE_MEDIA_PURPOSE: Readonly<Record<LectureType, MediaPurpose | null>> =
  Object.freeze({
    VIDEO: 'LECTURE_VIDEO',
    RESOURCE: 'LECTURE_RESOURCE',
    ARTICLE: null,
    QUIZ: null,
  });

/** Lecture types that may be marked as a free preview (invariant 4). */
export const PREVIEWABLE_LECTURE_TYPES = [
  'VIDEO',
  'ARTICLE',
] as const satisfies readonly LectureType[];

export const REVISION_KINDS = ['INITIAL', 'UPDATE'] as const;
export const RevisionKindSchema = z.enum(REVISION_KINDS);
export type RevisionKind = z.infer<typeof RevisionKindSchema>;

/** Derived revision lifecycle (design §4); there is no status column. */
export const REVISION_STATES = ['PENDING', 'LIVE', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED'] as const;
export const RevisionStateSchema = z.enum(REVISION_STATES);
export type RevisionState = z.infer<typeof RevisionStateSchema>;

export const COURSE_TRANSITION_ACTIONS = [
  'CREATE',
  'SUBMIT',
  'WITHDRAW',
  'APPROVE',
  'REJECT',
  'ARCHIVE',
  'RESTORE',
  'DELETE',
] as const;
export const CourseTransitionActionSchema = z.enum(COURSE_TRANSITION_ACTIONS);
export type CourseTransitionAction = z.infer<typeof CourseTransitionActionSchema>;

export const BULLET_KINDS = ['OUTCOME', 'REQUIREMENT'] as const;
export const BulletKindSchema = z.enum(BULLET_KINDS);
export type BulletKind = z.infer<typeof BulletKindSchema>;

/* ----------------------------------------------------------------------------------------
 * Limits and readiness thresholds
 * -------------------------------------------------------------------------------------- */

/** Curriculum size limits (design §4); exceeding one is 422 `curriculum_limit_exceeded`. */
export const CURRICULUM_LIMITS = Object.freeze({
  maxSectionsPerCourse: 50,
  maxLecturesPerSection: 100,
  maxLecturesPerCourse: 500,
  maxPreviewLectures: 10,
  /** Outcomes and requirements each (`course_bullets.position < 10`). */
  maxBulletsPerKind: 10,
});

/**
 * Submission thresholds (design §4 invariant 6, §13 Q6). The api reads the configurable
 * ones from `CATALOG_SUBMIT_MIN_LECTURES` / `CATALOG_SUBMIT_MIN_VIDEO_SECONDS` (dev/e2e use
 * 1 and 0) and falls back to these defaults.
 */
export const COURSE_SUBMISSION_DEFAULTS = Object.freeze({
  minLectures: 5,
  minVideoSeconds: 30 * 60,
});

/** Fixed readiness rules (not configurable). */
export const COURSE_READINESS_RULES = Object.freeze({
  /** Plain-text characters of the rendered description. */
  minDescriptionChars: 200,
  minOutcomes: 4,
  minArticleChars: 50,
});

/* ----------------------------------------------------------------------------------------
 * Field schemas (lengths = DB CHECKs)
 * -------------------------------------------------------------------------------------- */

export const CourseTitleSchema = singleLineText(5, 60);
export const CourseSubtitleSchema = singleLineText(10, 120);
export const CourseDescriptionSchema = markdownText(1, 20_000);
/** One outcome or requirement line. */
export const CourseBulletSchema = singleLineText(1, 160);
export const CourseBulletListSchema = z
  .array(CourseBulletSchema)
  .max(CURRICULUM_LIMITS.maxBulletsPerKind);

export const SectionTitleSchema = singleLineText(1, 80);
export const SectionObjectiveSchema = singleLineText(1, 200);
export const LectureTitleSchema = singleLineText(1, 80);
export const LectureDescriptionSchema = markdownText(1, 2_000);
/** Article body; may be empty while drafting (readiness requires 50 characters). */
export const ArticleBodySchema = markdownText(0, 100_000);

export const CategoryNameSchema = singleLineText(2, 60);

/** Optional note from the instructor to the reviewer on submit (`submitter_note` ≤ 1000). */
export const SubmitNoteSchema = multilineText(1, 1000);

/** Reject and admin takedown reasons: 10–2000 (design §4 invariant 8). */
export const ModerationReasonSchema = multilineText(10, 2000);

/**
 * Optional free text stored as a transition reason (approval note, owner archive reason).
 * Bounded by the transition `reason` column (≤ 2000).
 */
export const TransitionNoteSchema = multilineText(1, 2000);

/* ----------------------------------------------------------------------------------------
 * Route params shared by the instructor, admin and public routes
 * -------------------------------------------------------------------------------------- */

export const CourseIdParamsSchema = z.object({ courseId: UuidSchema });
export type CourseIdParams = z.output<typeof CourseIdParamsSchema>;

export const SectionParamsSchema = z.object({ courseId: UuidSchema, sectionId: UuidSchema });
export type SectionParams = z.output<typeof SectionParamsSchema>;

export const LectureParamsSchema = z.object({ courseId: UuidSchema, lectureId: UuidSchema });
export type LectureParams = z.output<typeof LectureParamsSchema>;

export const RevisionIdParamsSchema = z.object({ revisionId: UuidSchema });
export type RevisionIdParams = z.output<typeof RevisionIdParamsSchema>;

export const CourseRevisionParamsSchema = z.object({
  courseId: UuidSchema,
  revisionId: UuidSchema,
});
export type CourseRevisionParams = z.output<typeof CourseRevisionParamsSchema>;

export const RevisionLectureParamsSchema = z.object({
  revisionId: UuidSchema,
  lectureId: UuidSchema,
});
export type RevisionLectureParams = z.output<typeof RevisionLectureParamsSchema>;

export const CategoryIdParamsSchema = z.object({ id: UuidSchema });
export type CategoryIdParams = z.output<typeof CategoryIdParamsSchema>;

/** Small person reference (owner, instructor) resolved through `UsersFacade`. */
export const PersonRefSchema = z.object({ id: UuidSchema, displayName: z.string() });
export type PersonRef = z.infer<typeof PersonRefSchema>;
