import { z } from 'zod';
import { PersonRefSchema } from './catalog';
import { IsoDateTimeSchema, markdownText, singleLineText, UuidSchema } from './fields';
import { CompactPaginationQuerySchema, emptyToUndefined, pageSchema } from './pagination';

/**
 * Q&A (Phase 5 learning experience design D12, §4 Question, §5, §8 Q&A). The same routes serve
 * the student and the instructor BFF (P `qa:participate`); the use case admits ACTIVE learners
 * or the course owner (403 `enrollment_required` otherwise, also for an instructor-app token on a
 * course the caller does not own).
 *
 * Titles are plain text; bodies are markdown (`markdown_not_allowed`, render with `MarkdownView`).
 * Hidden content is 404 for everyone except its author (who gets `hidden: true` and a banner) and
 * admins. Counts are trigger-maintained; the `top` sort is not stable under concurrent votes, so
 * clients de-duplicate pages by id (decision P5-D12).
 *
 * Routes:
 *   GET    /courses/:courseId/questions?lectureId=&sort=&q=&cursor=&limit= -> 200 QuestionPage (400, 403, 404)
 *   POST   /courses/:courseId/questions                     -> 201 Question (403, 404, 422, 429)
 *   GET    /courses/:courseId/questions/:questionId         -> 200 QuestionDetail (first answers page)
 *   PATCH  /courses/:courseId/questions/:questionId         -> 200 Question (403 not_content_author, 404, 422)
 *   DELETE /courses/:courseId/questions/:questionId         -> 204 (403, 404)
 *   GET    /courses/:courseId/questions/:questionId/answers?cursor=&limit= -> 200 AnswerPage
 *   POST   /courses/:courseId/questions/:questionId/answers -> 201 Answer (403, 404, 422, 429)
 *   PATCH  /courses/:courseId/answers/:answerId             -> 200 Answer (403, 404, 422)
 *   DELETE /courses/:courseId/answers/:answerId             -> 204 (403, 404)
 *   PUT    /courses/:courseId/questions/:questionId/vote    -> 204 (404, 422 cannot_vote_own_content, 429)
 *   DELETE /courses/:courseId/questions/:questionId/vote    -> 204
 *   PUT    /courses/:courseId/answers/:answerId/vote        -> 204 (404, 422, 429)
 *   DELETE /courses/:courseId/answers/:answerId/vote        -> 204
 *   PUT    /courses/:courseId/questions/:questionId/accepted-answer {answerId} -> 200 Question
 *          (403 not_content_author: question author or course owner only; 404 answer_not_found)
 *   DELETE /courses/:courseId/questions/:questionId/accepted-answer           -> 200 Question
 *   GET    /instructor/qa?courseId=&status=&cursor=&limit=  -> 200 InstructorQaPage (P course:engage:own; 400)
 */

export const QA_LIMITS = Object.freeze({
  titleMinChars: 5,
  titleMaxChars: 200,
  bodyMaxChars: 10_000,
  /** Title search: at least 3 characters (trigram). */
  searchMinChars: 3,
});

export const QuestionTitleSchema = singleLineText(QA_LIMITS.titleMinChars, QA_LIMITS.titleMaxChars);
export const QaBodySchema = markdownText(1, QA_LIMITS.bodyMaxChars);

export const QA_SORTS = ['recent', 'top', 'unanswered'] as const;
export const QaSortSchema = z.enum(QA_SORTS);
export type QaSort = z.infer<typeof QaSortSchema>;

export const QuestionParamsSchema = z.object({ courseId: UuidSchema, questionId: UuidSchema });
export type QuestionParams = z.output<typeof QuestionParamsSchema>;

export const AnswerParamsSchema = z.object({ courseId: UuidSchema, answerId: UuidSchema });
export type AnswerParams = z.output<typeof AnswerParamsSchema>;

export const QuestionsQuerySchema = CompactPaginationQuerySchema.extend({
  /** Only this lecture's questions; omitted = the whole course (general + every lecture). */
  lectureId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
  sort: z.preprocess(emptyToUndefined, QaSortSchema.default('recent')),
  q: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(QA_LIMITS.searchMinChars).max(100).optional(),
  ),
});
export type QuestionsQuery = z.output<typeof QuestionsQuerySchema>;

/** Author of a question or answer; `author` null = a banned user ("Former student"). */
const qaAuthorFields = {
  author: PersonRefSchema.nullable(),
  /** Computed at read time: the author owns the course (ownership is immutable). */
  byInstructor: z.boolean(),
  /** The caller wrote it (edit/delete controls). */
  mine: z.boolean(),
};

export const QuestionSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  /** Null = a general course question. */
  lectureId: UuidSchema.nullable(),
  /** Null when deleted ("[deleted]" placeholder, kept because it has answers). */
  title: z.string().nullable(),
  bodyMd: z.string().nullable(),
  ...qaAuthorFields,
  upvoteCount: z.number().int().min(0),
  answerCount: z.number().int().min(0),
  acceptedAnswerId: UuidSchema.nullable(),
  /** `acceptedAnswerId !== null`. */
  resolved: z.boolean(),
  /** The caller up-voted it. */
  voted: z.boolean(),
  /** Hidden by moderation; only the author (and admins) see such a question. */
  hidden: z.boolean(),
  deleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionPageSchema = pageSchema(QuestionSchema);
export type QuestionPage = z.infer<typeof QuestionPageSchema>;

export const AnswerSchema = z.object({
  id: UuidSchema,
  questionId: UuidSchema,
  /** Null when deleted. */
  bodyMd: z.string().nullable(),
  ...qaAuthorFields,
  upvoteCount: z.number().int().min(0),
  voted: z.boolean(),
  accepted: z.boolean(),
  hidden: z.boolean(),
  deleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** Oldest first, keyset (createdAt, id). */
export const AnswerPageSchema = pageSchema(AnswerSchema);
export type AnswerPage = z.infer<typeof AnswerPageSchema>;

export const AnswersQuerySchema = CompactPaginationQuerySchema;
export type AnswersQuery = z.output<typeof AnswersQuerySchema>;

export const QuestionDetailSchema = QuestionSchema.extend({ answers: AnswerPageSchema });
export type QuestionDetail = z.infer<typeof QuestionDetailSchema>;

/** The lecture must be in the live revision (404 `lecture_not_found`). */
export const AskQuestionRequestSchema = z.object({
  lectureId: UuidSchema.nullable().optional(),
  title: QuestionTitleSchema,
  bodyMd: QaBodySchema,
});
export type AskQuestionRequest = z.output<typeof AskQuestionRequestSchema>;

export const EditQuestionRequestSchema = z
  .object({ title: QuestionTitleSchema.optional(), bodyMd: QaBodySchema.optional() })
  .refine((body) => body.title !== undefined || body.bodyMd !== undefined, {
    message: 'At least one of title or bodyMd is required',
  })
  .meta({ minProperties: 1 });
export type EditQuestionRequest = z.output<typeof EditQuestionRequestSchema>;

export const PostAnswerRequestSchema = z.object({ bodyMd: QaBodySchema });
export type PostAnswerRequest = z.output<typeof PostAnswerRequestSchema>;

export const EditAnswerRequestSchema = PostAnswerRequestSchema;
export type EditAnswerRequest = PostAnswerRequest;

export const AcceptAnswerRequestSchema = z.object({ answerId: UuidSchema });
export type AcceptAnswerRequest = z.output<typeof AcceptAnswerRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /instructor/qa?courseId=&status=&cursor=&limit= (P course:engage:own)
 * Over the caller's own courses (or one of them); unanswered first is `status=unanswered`.
 * -------------------------------------------------------------------------------------- */

export const INSTRUCTOR_QA_STATUSES = ['unanswered', 'unresolved', 'all'] as const;
export const InstructorQaStatusSchema = z.enum(INSTRUCTOR_QA_STATUSES);
export type InstructorQaStatus = z.infer<typeof InstructorQaStatusSchema>;

export const InstructorQaQuerySchema = CompactPaginationQuerySchema.extend({
  courseId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
  status: z.preprocess(emptyToUndefined, InstructorQaStatusSchema.default('unanswered')),
});
export type InstructorQaQuery = z.output<typeof InstructorQaQuerySchema>;

export const InstructorQaItemSchema = z.object({
  question: QuestionSchema,
  course: z.object({ id: UuidSchema, slug: z.string(), title: z.string() }),
  /** Title of the lecture the question is about (live revision); null for general questions. */
  lectureTitle: z.string().nullable(),
});
export type InstructorQaItem = z.infer<typeof InstructorQaItemSchema>;

export const InstructorQaPageSchema = pageSchema(InstructorQaItemSchema);
export type InstructorQaPage = z.infer<typeof InstructorQaPageSchema>;
