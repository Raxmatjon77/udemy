import { z } from 'zod';
import { markdownText, IsoDateTimeSchema, singleLineText, UuidSchema } from './fields';

/**
 * Quiz authoring (Phase 5 learning experience design D6, §5 catalog, §8 instructor and admin).
 *
 * A QUIZ lecture's content lives in the catalog working copy (`lecture_quizzes`,
 * `quiz_questions`, `quiz_options`) and is snapshotted into `revision_quiz_*` on submit, so the
 * answer keys are moderated and immutable per revision.
 *
 * **Answer keys (`isCorrect`, `explanationMd`) appear only in the schemas of this file**, which
 * serve the course owner (`Pol course:read`/`course:update`) and admins (`course:read:any`).
 * The student-facing attempt schemas in `learning.ts` never carry them before a submit.
 */

export const QUIZ_QUESTION_KINDS = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'] as const;
export const QuizQuestionKindSchema = z.enum(QUIZ_QUESTION_KINDS);
export type QuizQuestionKind = z.infer<typeof QuizQuestionKindSchema>;

export const QUIZ_QUESTION_KIND_LABELS: Readonly<Record<QuizQuestionKind, string>> = Object.freeze({
  SINGLE_CHOICE: 'Single choice',
  MULTIPLE_CHOICE: 'Multiple choice',
});

/** Limits (§5, §6). More questions: 422 `quiz_limit_exceeded`. */
export const QUIZ_LIMITS = Object.freeze({
  maxQuestions: 50,
  minOptions: 2,
  maxOptions: 6,
  /** `lecture_quizzes.pass_pct` default for a new QUIZ lecture. */
  defaultPassPct: 70,
});

/** `pass_pct` 1–100: the score (rounded percent of correct questions) needed to pass. */
export const QuizPassPctSchema = z.number().int().min(1).max(100);

/** `quiz_questions.prompt_md` 1–2000 (markdown, `markdown_not_allowed` from the api). */
export const QuizPromptSchema = markdownText(1, 2000);
/** `quiz_questions.explanation_md` ≤ 2000; shown to the learner only after passing (Q5). */
export const QuizExplanationSchema = markdownText(1, 2000);
/** `quiz_options.text` 1–300, plain text. */
export const QuizOptionTextSchema = singleLineText(1, 300);

/** Option positions are 0-based, `0..maxOptions-1` (`quiz_options.position`). */
export const QuizOptionPositionSchema = z
  .number()
  .int()
  .min(0)
  .max(QUIZ_LIMITS.maxOptions - 1);

/** Settings of a QUIZ lecture as `Lecture.quiz` and the live curriculum carry them. */
export const LectureQuizSummarySchema = z.object({
  passPct: QuizPassPctSchema,
  questionCount: z.number().int().min(0).max(QUIZ_LIMITS.maxQuestions),
});
export type LectureQuizSummary = z.infer<typeof LectureQuizSummarySchema>;

/**
 * The readiness rule for one question (§5 `QUIZ_QUESTION_INVALID`): 2–6 options, SINGLE has
 * exactly one correct option, MULTIPLE at least one. The working copy may be incomplete; the
 * builder shows this inline and the api blocks the submit.
 */
export function isQuizQuestionComplete(
  kind: QuizQuestionKind,
  options: readonly { isCorrect: boolean }[],
): boolean {
  if (options.length < QUIZ_LIMITS.minOptions || options.length > QUIZ_LIMITS.maxOptions) {
    return false;
  }
  const correct = options.filter((option) => option.isCorrect).length;
  return kind === 'SINGLE_CHOICE' ? correct === 1 : correct >= 1;
}

/* ----------------------------------------------------------------------------------------
 * Working copy (instructor BFF; Pol course:read for GET, course:update for writes; every write
 * takes the P2 course lock, bumps `version` and is 409 `course_in_review` while pending):
 *
 *   GET    /courses/:courseId/lectures/:lectureId/quiz                        -> 200 QuizAuthoring
 *   PUT    /courses/:courseId/lectures/:lectureId/quiz            {passPct}   -> 200 QuizAuthoring
 *   POST   /courses/:courseId/lectures/:lectureId/quiz/questions             -> 201 QuizQuestionAuthoring
 *   PATCH  /courses/:courseId/lectures/:lectureId/quiz/questions/:questionId -> 200 QuizQuestionAuthoring
 *   DELETE /courses/:courseId/lectures/:lectureId/quiz/questions/:questionId -> 204
 *   PUT    /courses/:courseId/lectures/:lectureId/quiz/questions/:questionId/options
 *                                                                            -> 200 QuizQuestionAuthoring
 *   PUT    /courses/:courseId/lectures/:lectureId/quiz/order  {questionIds} -> 200 QuizAuthoring
 *
 * Errors: 404 course_not_found | lecture_not_found | quiz_question_not_found, 409 course_in_review |
 * order_mismatch, 422 lecture_type_mismatch (not a QUIZ) | markdown_not_allowed |
 * quiz_limit_exceeded | quiz_options_invalid. Params: `LectureParamsSchema` /
 * `QuizQuestionParamsSchema`.
 * -------------------------------------------------------------------------------------- */

export const QuizQuestionParamsSchema = z.object({
  courseId: UuidSchema,
  lectureId: UuidSchema,
  questionId: UuidSchema,
});
export type QuizQuestionParams = z.output<typeof QuizQuestionParamsSchema>;

export const QuizOptionAuthoringSchema = z.object({
  position: QuizOptionPositionSchema,
  text: z.string(),
  isCorrect: z.boolean(),
});
export type QuizOptionAuthoring = z.infer<typeof QuizOptionAuthoringSchema>;

export const QuizQuestionAuthoringSchema = z.object({
  id: UuidSchema,
  /** 0-based, contiguous. */
  position: z.number().int().min(0),
  kind: QuizQuestionKindSchema,
  promptMd: z.string(),
  explanationMd: z.string().nullable(),
  /** Ordered by position; may be empty or incomplete while drafting. */
  options: z.array(QuizOptionAuthoringSchema).max(QUIZ_LIMITS.maxOptions),
  /** `isQuizQuestionComplete(kind, options)`, computed by the api. */
  complete: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type QuizQuestionAuthoring = z.infer<typeof QuizQuestionAuthoringSchema>;

export const QuizAuthoringSchema = z.object({
  courseId: UuidSchema,
  lectureId: UuidSchema,
  /** Course version after the last write (quiz writes bump it like curriculum writes). */
  version: z.number().int().min(1),
  /** True while a revision is pending: the working copy is read-only (P2 D2). */
  locked: z.boolean(),
  passPct: QuizPassPctSchema,
  questions: z.array(QuizQuestionAuthoringSchema).max(QUIZ_LIMITS.maxQuestions),
  updatedAt: IsoDateTimeSchema,
});
export type QuizAuthoring = z.infer<typeof QuizAuthoringSchema>;

export const UpdateQuizSettingsRequestSchema = z.object({ passPct: QuizPassPctSchema });
export type UpdateQuizSettingsRequest = z.output<typeof UpdateQuizSettingsRequestSchema>;

/** Appended at the end; options are set with `PUT …/options`. */
export const CreateQuizQuestionRequestSchema = z.object({
  kind: QuizQuestionKindSchema,
  promptMd: QuizPromptSchema,
  explanationMd: QuizExplanationSchema.optional(),
});
export type CreateQuizQuestionRequest = z.output<typeof CreateQuizQuestionRequestSchema>;

/** Changing `kind` keeps the options; readiness re-checks the correct count. */
export const UpdateQuizQuestionRequestSchema = z
  .object({
    kind: QuizQuestionKindSchema.optional(),
    promptMd: QuizPromptSchema.optional(),
    explanationMd: QuizExplanationSchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of kind, promptMd or explanationMd is required',
  })
  .meta({ minProperties: 1 });
export type UpdateQuizQuestionRequest = z.output<typeof UpdateQuizQuestionRequestSchema>;

/**
 * Replaces all options of a question (positions follow the array order). 2–6 options with
 * distinct texts; the correct-count rule is a readiness issue, not a write error, so a draft can
 * be saved half-done. The api re-checks the list (422 `quiz_options_invalid`).
 */
export const PutQuizQuestionOptionsRequestSchema = z.object({
  options: z
    .array(z.object({ text: QuizOptionTextSchema, isCorrect: z.boolean() }))
    .min(QUIZ_LIMITS.minOptions)
    .max(QUIZ_LIMITS.maxOptions)
    .refine(
      (options) => new Set(options.map((o) => o.text.toLowerCase())).size === options.length,
      { message: 'Option texts must be distinct' },
    ),
});
export type PutQuizQuestionOptionsRequest = z.output<typeof PutQuizQuestionOptionsRequestSchema>;

/** The full question order: an exact permutation of the current ids (409 `order_mismatch`). */
export const ReorderQuizQuestionsRequestSchema = z.object({
  questionIds: z
    .array(UuidSchema)
    .max(QUIZ_LIMITS.maxQuestions)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Question ids must be unique' }),
});
export type ReorderQuizQuestionsRequest = z.output<typeof ReorderQuizQuestionsRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/course-revisions/:revisionId/lectures/:lectureId/quiz -> 200 RevisionQuiz
 * (P course:read:any; 404). The immutable snapshot, with keys, for the moderation review.
 * Params: `RevisionLectureParamsSchema`.
 * -------------------------------------------------------------------------------------- */

export const RevisionQuizQuestionSchema = z.object({
  id: UuidSchema,
  position: z.number().int().min(0),
  kind: QuizQuestionKindSchema,
  promptMd: z.string(),
  explanationMd: z.string().nullable(),
  options: z
    .array(QuizOptionAuthoringSchema)
    .min(QUIZ_LIMITS.minOptions)
    .max(QUIZ_LIMITS.maxOptions),
});
export type RevisionQuizQuestion = z.infer<typeof RevisionQuizQuestionSchema>;

export const RevisionQuizSchema = z.object({
  revisionId: UuidSchema,
  lectureId: UuidSchema,
  passPct: QuizPassPctSchema,
  questions: z.array(RevisionQuizQuestionSchema).min(1).max(QUIZ_LIMITS.maxQuestions),
});
export type RevisionQuiz = z.infer<typeof RevisionQuizSchema>;
