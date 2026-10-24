import {
  COURSE_LANGUAGES,
  COURSE_READINESS_RULES,
  type CourseReadiness,
  type CourseReadinessIssue,
  type CourseReadinessIssueCode,
  isQuizQuestionComplete,
  type LectureType,
  type MediaAssetStatus,
  type QuizQuestionKind,
} from '@udemy/contracts';

export type { CourseReadiness, CourseReadinessIssue };

/** Configurable thresholds (`CATALOG_SUBMIT_MIN_LECTURES` / `_MIN_VIDEO_SECONDS`, §13 Q6). */
export interface ReadinessThresholds {
  readonly minLectures: number;
  readonly minVideoSeconds: number;
}

/** Fresh media facts of one asset (from MediaFacade.getAssets in the caller's transaction). */
export interface ReadinessAsset {
  readonly status: MediaAssetStatus;
  readonly purged: boolean;
  /** Seconds, videos only once READY. */
  readonly durationSeconds: number | null;
}

export interface ReadinessLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly mediaAssetId: string | null;
  /** The attached asset; null when there is none or it no longer exists. */
  readonly asset: ReadinessAsset | null;
  /** ARTICLE lectures: plain-text length of the body (0 when never saved); else null. */
  readonly articlePlainLength: number | null;
  /** QUIZ lectures: the working-copy questions (null or absent: no quiz content). */
  readonly quiz?: ReadinessQuiz | null;
}

/** The facts of a QUIZ lecture readiness looks at (Phase 5 design §5). */
export interface ReadinessQuiz {
  readonly questions: readonly {
    readonly kind: QuizQuestionKind;
    readonly options: readonly { readonly isCorrect: boolean }[];
  }[];
}

export interface ReadinessSection {
  readonly id: string;
  readonly lectures: readonly ReadinessLecture[];
}

/** Everything invariant 6 looks at, gathered by the application layer. */
export interface ReadinessInput {
  readonly subtitle: string | null;
  /** Plain-text length of the description markdown; null without a description. */
  readonly descriptionPlainLength: number | null;
  readonly language: string | null;
  readonly level: string | null;
  readonly categoryId: string | null;
  /** The assigned category is active and so is its group; null without a category. */
  readonly categoryActive: boolean | null;
  readonly thumbnailAssetId: string | null;
  readonly thumbnail: ReadinessAsset | null;
  readonly outcomeCount: number;
  /** Sections in curriculum order with their lectures in order. */
  readonly sections: readonly ReadinessSection[];
}

function issue(
  code: CourseReadinessIssueCode,
  extra: Partial<Omit<CourseReadinessIssue, 'code'>> = {},
): CourseReadinessIssue {
  return {
    code,
    sectionId: extra.sectionId ?? null,
    lectureId: extra.lectureId ?? null,
    required: extra.required ?? null,
    actual: extra.actual ?? null,
  };
}

function isReady(asset: ReadinessAsset | null): boolean {
  return asset !== null && asset.status === 'READY' && !asset.purged;
}

const LANGUAGES: ReadonlySet<string> = new Set(COURSE_LANGUAGES);

/**
 * Invariant 6 (design §4): every reason the working copy cannot be submitted, all at once, in
 * a stable order (course header, thumbnail, outcomes, curriculum, then per-lecture issues in
 * curriculum order). Pure: the caller supplies fresh asset states (and, at submit, reads them
 * inside the submit transaction).
 */
export function evaluateReadiness(
  input: ReadinessInput,
  thresholds: ReadinessThresholds,
): CourseReadiness {
  const issues: CourseReadinessIssue[] = [];

  if (input.subtitle === null || input.subtitle.trim() === '')
    issues.push(issue('SUBTITLE_MISSING'));
  const descriptionLength = input.descriptionPlainLength ?? 0;
  if (descriptionLength < COURSE_READINESS_RULES.minDescriptionChars) {
    issues.push(
      issue('DESCRIPTION_TOO_SHORT', {
        required: COURSE_READINESS_RULES.minDescriptionChars,
        actual: descriptionLength,
      }),
    );
  }
  if (input.language === null || !LANGUAGES.has(input.language))
    issues.push(issue('LANGUAGE_MISSING'));
  if (input.level === null) issues.push(issue('LEVEL_MISSING'));
  if (input.categoryId === null) issues.push(issue('CATEGORY_MISSING'));
  else if (input.categoryActive !== true) issues.push(issue('CATEGORY_INACTIVE'));

  if (input.thumbnailAssetId === null) issues.push(issue('THUMBNAIL_MISSING'));
  else if (!isReady(input.thumbnail)) issues.push(issue('THUMBNAIL_NOT_READY'));

  if (input.outcomeCount < COURSE_READINESS_RULES.minOutcomes) {
    issues.push(
      issue('TOO_FEW_OUTCOMES', {
        required: COURSE_READINESS_RULES.minOutcomes,
        actual: input.outcomeCount,
      }),
    );
  }

  if (input.sections.length === 0) issues.push(issue('NO_SECTIONS'));
  for (const section of input.sections) {
    if (section.lectures.length === 0)
      issues.push(issue('SECTION_EMPTY', { sectionId: section.id }));
  }

  const lectureCount = input.sections.reduce((n, s) => n + s.lectures.length, 0);
  if (lectureCount < thresholds.minLectures) {
    issues.push(
      issue('TOO_FEW_LECTURES', { required: thresholds.minLectures, actual: lectureCount }),
    );
  }

  const videoSeconds = readyVideoSeconds(input.sections);
  if (videoSeconds < thresholds.minVideoSeconds) {
    issues.push(
      issue('NOT_ENOUGH_VIDEO', { required: thresholds.minVideoSeconds, actual: videoSeconds }),
    );
  }

  for (const section of input.sections) {
    for (const lecture of section.lectures) {
      const at = { sectionId: section.id, lectureId: lecture.id };
      if (lecture.type === 'QUIZ') {
        issues.push(...quizIssues(lecture.quiz ?? null, at));
      } else if (lecture.type === 'ARTICLE') {
        const length = lecture.articlePlainLength ?? 0;
        if (length < COURSE_READINESS_RULES.minArticleChars) {
          issues.push(
            issue('ARTICLE_TOO_SHORT', {
              ...at,
              required: COURSE_READINESS_RULES.minArticleChars,
              actual: length,
            }),
          );
        }
      } else if (lecture.mediaAssetId === null || lecture.asset === null) {
        issues.push(issue('LECTURE_MEDIA_MISSING', at));
      } else if (!isReady(lecture.asset)) {
        issues.push(issue('LECTURE_MEDIA_NOT_READY', at));
      }
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * QUIZ readiness (Phase 5 design §5): `QUIZ_EMPTY` without questions (required 1, actual 0);
 * otherwise ONE `QUIZ_QUESTION_INVALID` per lecture when any question breaks the key rule
 * (2–6 options, SINGLE exactly one correct, MULTIPLE at least one; `isQuizQuestionComplete`),
 * with `actual` = the number of such questions. A QUIZ has no media, so the media rules never
 * apply to it.
 */
function quizIssues(
  quiz: ReadinessQuiz | null,
  at: { readonly sectionId: string; readonly lectureId: string },
): CourseReadinessIssue[] {
  const questions = quiz?.questions ?? [];
  if (questions.length === 0) return [issue('QUIZ_EMPTY', { ...at, required: 1, actual: 0 })];
  const invalid = questions.filter((q) => !isQuizQuestionComplete(q.kind, q.options)).length;
  return invalid === 0 ? [] : [issue('QUIZ_QUESTION_INVALID', { ...at, actual: invalid })];
}

/** Total seconds of READY video lectures (what the landing page will show). */
export function readyVideoSeconds(sections: readonly ReadinessSection[]): number {
  let total = 0;
  for (const section of sections) {
    for (const lecture of section.lectures) {
      if (lecture.type === 'VIDEO' && isReady(lecture.asset)) {
        total += lecture.asset?.durationSeconds ?? 0;
      }
    }
  }
  return total;
}
