import { z } from 'zod';
import { type LectureType, LectureTypeSchema, PersonRefSchema } from './catalog';
import { IsoDateTimeSchema, markdownText, multilineText, UuidSchema } from './fields';
import { pageSchema, CompactPaginationQuerySchema, emptyToUndefined } from './pagination';
import {
  LectureQuizSummarySchema,
  QUIZ_LIMITS,
  QuizOptionPositionSchema,
  QuizPassPctSchema,
  QuizQuestionKindSchema,
} from './quiz';

/**
 * Learning (Phase 5 learning experience design D1–D9, §4 learning, §5, §8 student). Enums mirror
 * the `learning.*` CHECK constraints; the api domain stays authoritative.
 *
 * Every `/me/courses/:courseId/...` route: 404 `course_not_found` / `lecture_not_found` (the
 * lecture must be in the live revision), then 403 `enrollment_required` unless the caller has an
 * ACTIVE enrollment. The course owner gets a read-only PREVIEW bootstrap; owner writes are 403.
 */

/* ----------------------------------------------------------------------------------------
 * Enums and rules
 * -------------------------------------------------------------------------------------- */

/** `lecture_completions.cause`. */
export const LECTURE_COMPLETION_CAUSES = [
  'VIDEO_WATCHED',
  'ARTICLE_READ',
  'RESOURCE_OPENED',
  'QUIZ_PASSED',
  'MANUAL',
] as const;
export const LectureCompletionCauseSchema = z.enum(LECTURE_COMPLETION_CAUSES);
export type LectureCompletionCause = z.infer<typeof LectureCompletionCauseSchema>;

/**
 * The causes each lecture type may complete with (D4, the `lecture_completions` CHECK). Manual
 * completion is ARTICLE/RESOURCE only; VIDEO and QUIZ are measured by the server.
 */
export const LECTURE_COMPLETION_CAUSES_BY_TYPE: Readonly<
  Record<LectureType, readonly LectureCompletionCause[]>
> = Object.freeze({
  VIDEO: Object.freeze(['VIDEO_WATCHED'] as const),
  ARTICLE: Object.freeze(['ARTICLE_READ', 'MANUAL'] as const),
  RESOURCE: Object.freeze(['RESOURCE_OPENED', 'MANUAL'] as const),
  QUIZ: Object.freeze(['QUIZ_PASSED'] as const),
});

export function isCompletionCauseAllowed(
  type: LectureType,
  cause: LectureCompletionCause,
): boolean {
  return LECTURE_COMPLETION_CAUSES_BY_TYPE[type].includes(cause);
}

/** Causes a client may send to `POST …/completion`; the others are set by the server. */
export const CLIENT_COMPLETION_CAUSES = [
  'ARTICLE_READ',
  'RESOURCE_OPENED',
  'MANUAL',
] as const satisfies readonly LectureCompletionCause[];
export const ClientCompletionCauseSchema = z.enum(CLIENT_COMPLETION_CAUSES);
export type ClientCompletionCause = z.infer<typeof ClientCompletionCauseSchema>;

/** Lecture types with a "Mark complete" checkbox (D4, decision P5-D3). */
export const MANUALLY_COMPLETABLE_LECTURE_TYPES = [
  'ARTICLE',
  'RESOURCE',
] as const satisfies readonly LectureType[];

/**
 * Progress measurement (D2, D3). `videoCompleteRatio` is the default of
 * `LEARNING_VIDEO_COMPLETE_RATIO`; the server is authoritative, the client only shows it.
 */
export const LEARNING_PROGRESS_RULES = Object.freeze({
  /** Coverage bitmap granularity: one bit per 5 seconds of video. */
  bucketSeconds: 5,
  videoCompleteRatio: 0.9,
  /** The player sends a heartbeat every 15 s while playing, and on pause/seeked/ended/pagehide. */
  heartbeatIntervalSeconds: 15,
  maxRangesPerHeartbeat: 32,
  /** New seconds per heartbeat ≤ elapsed × factor + slack (first heartbeat: firstSeconds). */
  plausibilityFactor: 2.5,
  plausibilitySlackSeconds: 10,
  plausibilityFirstSeconds: 60,
  /** Upper bound of any position or range bound (a day of video). */
  maxSeconds: 86_400,
});

/** Notes and attempts (§4, §5). */
export const LEARNING_LIMITS = Object.freeze({
  maxNotesPerCourse: 500,
  noteBodyMaxChars: 2000,
  /** IN_PROGRESS attempts older than this are ABANDONED (`LEARNING_QUIZ_ATTEMPT_TTL_H`). */
  quizAttemptTtlHours: 24,
});

/** A fixed-window rate-limit rule of design §9 (`per` names the bucket key). */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly per: 'user' | 'ip' | 'instructor';
}

/** Learning rate limits (§9); a hit is 429 `rate_limited` with `Retry-After`. */
export const LEARNING_RATE_LIMITS = Object.freeze({
  /** The client drops a 429 heartbeat silently. */
  heartbeat: { limit: 40, windowSeconds: 60, per: 'user' },
  completionToggle: { limit: 120, windowSeconds: 3600, per: 'user' },
  noteWrite: { limit: 120, windowSeconds: 3600, per: 'user' },
  quizStart: { limit: 30, windowSeconds: 3600, per: 'user' },
  quizSubmit: { limit: 60, windowSeconds: 3600, per: 'user' },
  certificateVerify: { limit: 120, windowSeconds: 60, per: 'ip' },
} as const satisfies Record<string, RateLimitRule>);

/** `GET /me/courses/:courseId/learn` mode: LEARNER (ACTIVE enrollment) or PREVIEW (owner). */
export const PLAYER_MODES = ['LEARNER', 'PREVIEW'] as const;
export const PlayerModeSchema = z.enum(PLAYER_MODES);
export type PlayerMode = z.infer<typeof PlayerModeSchema>;

/** Courses a player can open: archived courses stay available to enrolled learners. */
export const PLAYABLE_COURSE_STATUSES = ['PUBLISHED', 'ARCHIVED'] as const;
export const PlayableCourseStatusSchema = z.enum(PLAYABLE_COURSE_STATUSES);
export type PlayableCourseStatus = z.infer<typeof PlayableCourseStatusSchema>;

const seconds = () => z.number().int().min(0).max(LEARNING_PROGRESS_RULES.maxSeconds);
const percent = () => z.number().int().min(0).max(100);

/** Lecture route params: `LectureParamsSchema` (catalog) is reused for `/me/courses/…/lectures/…`. */

/* ----------------------------------------------------------------------------------------
 * GET /me/courses/:courseId/learn -> 200 PlayerBootstrap (P learning:participate; 403, 404)
 * Lazily re-evaluates the course completion (D5).
 * -------------------------------------------------------------------------------------- */

/**
 * `{ completed, total, pct }` over the live lecture ids: pct = ⌊completed / total × 100⌋, so 100
 * means truly complete (D5). total 0 gives pct 0.
 */
export const CourseProgressSchema = z
  .object({
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
    pct: percent(),
  })
  .refine((p) => p.completed <= p.total, { message: 'completed ≤ total', path: ['completed'] });
export type CourseProgress = z.infer<typeof CourseProgressSchema>;

/** ⌊completed / total × 100⌋ (D5); 0 for an empty curriculum. */
export function progressPct(completed: number, total: number): number {
  return total <= 0 ? 0 : Math.floor((Math.min(completed, total) / total) * 100);
}

export const PlayerLectureSchema = z.object({
  id: UuidSchema,
  type: LectureTypeSchema,
  title: z.string(),
  /** VIDEO only (snapshotted at submit). */
  durationSeconds: z.number().int().min(0).nullable(),
  isPreview: z.boolean(),
  /** QUIZ only. */
  quiz: LectureQuizSummarySchema.nullable(),
  completed: z.boolean(),
  completedAt: IsoDateTimeSchema.nullable(),
  /** VIDEO only: the last position (Redis first, then the DB); null when never watched. */
  positionSeconds: seconds().nullable(),
  /** VIDEO only: ⌊covered buckets / buckets × 100⌋; null when never watched. */
  coveragePct: percent().nullable(),
});
export type PlayerLecture = z.infer<typeof PlayerLectureSchema>;

export const PlayerSectionSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  lectures: z.array(PlayerLectureSchema),
});
export type PlayerSection = z.infer<typeof PlayerSectionSchema>;

/** Where "Continue" starts: the last lecture (`course_activity`), else the first incomplete one. */
export const PlayerResumeSchema = z.object({
  lectureId: UuidSchema,
  positionSeconds: seconds().nullable(),
});
export type PlayerResume = z.infer<typeof PlayerResumeSchema>;

export const CERTIFICATE_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const CertificateStatusSchema = z.enum(CERTIFICATE_STATUSES);
export type CertificateStatus = z.infer<typeof CertificateStatusSchema>;

/** Public verification code: 26 Crockford base32 characters (128 random bits, D7). */
export const CERTIFICATE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const CertificateCodeSchema = z
  .string()
  .regex(CERTIFICATE_CODE_PATTERN, 'Invalid certificate code')
  .meta({ examples: ['01J9ZP4X6V8Q2M3N5R7T9W0Y1A'] });

export const PlayerCertificateSchema = z.object({
  id: UuidSchema,
  code: CertificateCodeSchema,
  status: CertificateStatusSchema,
});
export type PlayerCertificate = z.infer<typeof PlayerCertificateSchema>;

export const PlayerBootstrapSchema = z.object({
  courseId: UuidSchema,
  slug: z.string(),
  /** Live title. */
  title: z.string(),
  status: PlayableCourseStatusSchema,
  liveRevisionId: UuidSchema,
  /** PREVIEW (owner): heartbeats and writes are disabled, every learner field is empty. */
  mode: PlayerModeSchema,
  /** Null when the instructor is banned or unknown. */
  instructor: PersonRefSchema.nullable(),
  sections: z.array(PlayerSectionSchema),
  progress: CourseProgressSchema,
  /** Null in PREVIEW mode or for an empty curriculum. */
  resume: PlayerResumeSchema.nullable(),
  /** The permanent course completion (`course_completions`), if any. */
  completedAt: IsoDateTimeSchema.nullable(),
  /** Completed before, but a later revision added lectures (`pct < 100`): "New content" badge. */
  newContent: z.boolean(),
  /** Null until the worker issued it (poll or wait for `CERTIFICATE_ISSUED`). */
  certificate: PlayerCertificateSchema.nullable(),
});
export type PlayerBootstrap = z.infer<typeof PlayerBootstrapSchema>;

/* ----------------------------------------------------------------------------------------
 * PUT /me/courses/:courseId/lectures/:lectureId/progress -> 200 ProgressAck
 *   (P learning:participate; 403, 404, 422 lecture_type_mismatch (not a VIDEO with a duration),
 *    429 (drop silently), 503 (Redis; retry later)).
 * Whole seconds: the client floors `from` and ceils `to`. Ranges are what was played since the
 * last heartbeat; the server clamps them to the duration and to the plausibility budget (D3).
 * -------------------------------------------------------------------------------------- */

export const PlayedRangeSchema = z
  .object({ from: seconds(), to: seconds() })
  .refine((r) => r.to > r.from, { message: 'to must be greater than from', path: ['to'] });
export type PlayedRange = z.infer<typeof PlayedRangeSchema>;

export const RecordHeartbeatRequestSchema = z.object({
  positionSeconds: seconds(),
  ranges: z.array(PlayedRangeSchema).max(LEARNING_PROGRESS_RULES.maxRangesPerHeartbeat),
});
export type RecordHeartbeatRequest = z.output<typeof RecordHeartbeatRequestSchema>;

/** State after the heartbeat (not "changed by it"): the lecture and course are complete. */
export const ProgressAckSchema = z.object({
  lectureCompleted: z.boolean(),
  /** A `course_completions` row exists (permanent, even when pct dropped below 100 later). */
  courseCompleted: z.boolean(),
  coursePct: percent(),
});
export type ProgressAck = z.infer<typeof ProgressAckSchema>;

/* ----------------------------------------------------------------------------------------
 * POST   /me/courses/:courseId/lectures/:lectureId/completion {cause} -> 200 CompletionState
 * DELETE /me/courses/:courseId/lectures/:lectureId/completion         -> 200 CompletionState
 *   (P learning:participate; 403, 404, 422 completion_not_allowed, 429). Both are idempotent;
 *   un-completing never touches the course completion or a certificate.
 * -------------------------------------------------------------------------------------- */

export const CompleteLectureRequestSchema = z.object({ cause: ClientCompletionCauseSchema });
export type CompleteLectureRequest = z.output<typeof CompleteLectureRequestSchema>;

export const CompletionStateSchema = z
  .object({
    lectureId: UuidSchema,
    completed: z.boolean(),
    cause: LectureCompletionCauseSchema.nullable(),
    completedAt: IsoDateTimeSchema.nullable(),
    progress: CourseProgressSchema,
    courseCompletedAt: IsoDateTimeSchema.nullable(),
  })
  .refine((s) => s.completed === (s.cause !== null && s.completedAt !== null), {
    message: 'cause and completedAt are set exactly when completed',
    path: ['completed'],
  });
export type CompletionState = z.infer<typeof CompletionStateSchema>;

/* ----------------------------------------------------------------------------------------
 * Notes (private):
 *   GET    /me/courses/:courseId/notes?lectureId=&cursor=&limit= -> 200 NotePage (P note:manage:own)
 *   POST   /me/courses/:courseId/notes                           -> 201 Note (403, 404, 422, 429)
 *   PATCH  /me/notes/:noteId                                     -> 200 Note (Pol note:manage; 404, 422)
 *   DELETE /me/notes/:noteId                                     -> 204      (Pol note:manage; 404)
 * Keyset (createdAt DESC, id DESC). PATCH/DELETE work after a revoke (D9). 422
 * `note_limit_exceeded` (500 per course), `markdown_not_allowed`, `validation_failed` (a position
 * on a non-VIDEO lecture or beyond its duration).
 * -------------------------------------------------------------------------------------- */

export const NoteBodySchema = markdownText(1, LEARNING_LIMITS.noteBodyMaxChars);

export const NoteSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  lectureId: UuidSchema,
  /** VIDEO lectures only: click to seek. */
  positionSeconds: seconds().nullable(),
  bodyMd: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Note = z.infer<typeof NoteSchema>;

export const NotePageSchema = pageSchema(NoteSchema);
export type NotePage = z.infer<typeof NotePageSchema>;

export const NotesQuerySchema = CompactPaginationQuerySchema.extend({
  lectureId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
});
export type NotesQuery = z.output<typeof NotesQuerySchema>;

export const CreateNoteRequestSchema = z.object({
  lectureId: UuidSchema,
  positionSeconds: seconds().optional(),
  bodyMd: NoteBodySchema,
});
export type CreateNoteRequest = z.output<typeof CreateNoteRequestSchema>;

/** `positionSeconds: null` clears the timestamp. */
export const UpdateNoteRequestSchema = z
  .object({
    bodyMd: NoteBodySchema.optional(),
    positionSeconds: seconds().nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of bodyMd or positionSeconds is required',
  })
  .meta({ minProperties: 1 });
export type UpdateNoteRequest = z.output<typeof UpdateNoteRequestSchema>;

export const NoteIdParamsSchema = z.object({ noteId: UuidSchema });
export type NoteIdParams = z.output<typeof NoteIdParamsSchema>;

/* ----------------------------------------------------------------------------------------
 * Quiz attempts (D6, §4 QuizAttempt). The attempt schemas carry NO correctness fields; a
 * submitted attempt has a `result` that follows the reveal policy (decision P5-D5: right/wrong per
 * own answer always, correct options and explanations only when passed).
 *
 *   POST /me/courses/:courseId/lectures/:lectureId/quiz-attempts -> 201 QuizAttempt (new) /
 *        200 QuizAttempt (the open attempt of the live revision) (P quiz_attempt:create;
 *        403, 404, 422 lecture_type_mismatch, 429)
 *   GET  /me/courses/:courseId/lectures/:lectureId/quiz-attempts?cursor=&limit=
 *        -> 200 QuizAttemptPage (P quiz_attempt:read:own; 403, 404), newest first
 *   GET  /me/quiz-attempts/:attemptId -> 200 QuizAttemptDetail (Pol quiz_attempt:read; 404)
 *   POST /me/quiz-attempts/:attemptId/submit {answers} -> 200 SubmitQuizAttemptResponse
 *        (Pol quiz_attempt:submit; 404 quiz_attempt_not_found, 409 attempt_not_in_progress,
 *         422 quiz_answers_invalid, 429). A repeat of a SUBMITTED attempt returns the stored result.
 * -------------------------------------------------------------------------------------- */

export const QUIZ_ATTEMPT_STATUSES = ['IN_PROGRESS', 'SUBMITTED', 'ABANDONED'] as const;
export const QuizAttemptStatusSchema = z.enum(QUIZ_ATTEMPT_STATUSES);
export type QuizAttemptStatus = z.infer<typeof QuizAttemptStatusSchema>;

export const QuizAttemptIdParamsSchema = z.object({ attemptId: UuidSchema });
export type QuizAttemptIdParams = z.output<typeof QuizAttemptIdParamsSchema>;

/** An option as the learner sees it: no `isCorrect`. */
export const QuizAttemptOptionSchema = z.object({
  position: QuizOptionPositionSchema,
  text: z.string(),
});
export type QuizAttemptOption = z.infer<typeof QuizAttemptOptionSchema>;

/** A question as the learner sees it: no key, no explanation. */
export const QuizAttemptQuestionSchema = z.object({
  id: UuidSchema,
  position: z.number().int().min(0),
  kind: QuizQuestionKindSchema,
  promptMd: z.string(),
  options: z.array(QuizAttemptOptionSchema).min(QUIZ_LIMITS.minOptions).max(QUIZ_LIMITS.maxOptions),
});
export type QuizAttemptQuestion = z.infer<typeof QuizAttemptQuestionSchema>;

const QuizAttemptBaseSchema = z.object({
  id: UuidSchema,
  courseId: UuidSchema,
  lectureId: UuidSchema,
  /** The live revision when the attempt started; grading uses its key (D6). */
  revisionId: UuidSchema,
  status: QuizAttemptStatusSchema,
  passPct: QuizPassPctSchema,
  questionCount: z.number().int().min(1).max(QUIZ_LIMITS.maxQuestions),
  startedAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  abandonedAt: IsoDateTimeSchema.nullable(),
  /** In attempt order. */
  questions: z.array(QuizAttemptQuestionSchema).min(1).max(QUIZ_LIMITS.maxQuestions),
});

/** `POST …/quiz-attempts` (always IN_PROGRESS). */
export const QuizAttemptSchema = QuizAttemptBaseSchema;
export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

/** One graded question. `correctOptions`/`explanationMd` are null unless `revealed`. */
export const QuizQuestionResultSchema = z.object({
  questionId: UuidSchema,
  position: z.number().int().min(0),
  /** The learner's selection (empty = unanswered, which counts as wrong). */
  selectedOptions: z.array(QuizOptionPositionSchema).max(QUIZ_LIMITS.maxOptions),
  yourAnswerCorrect: z.boolean(),
  correctOptions: z.array(QuizOptionPositionSchema).max(QUIZ_LIMITS.maxOptions).nullable(),
  explanationMd: z.string().nullable(),
});
export type QuizQuestionResult = z.infer<typeof QuizQuestionResultSchema>;

const QuizResultBaseSchema = z.object({
  attemptId: UuidSchema,
  courseId: UuidSchema,
  lectureId: UuidSchema,
  /** round(correct / total × 100). */
  scorePct: percent(),
  correctCount: z.number().int().min(0),
  questionCount: z.number().int().min(1).max(QUIZ_LIMITS.maxQuestions),
  passPct: QuizPassPctSchema,
  /** scorePct ≥ passPct. */
  passed: z.boolean(),
  /** True when the reveal policy shows keys and explanations (default: when passed). */
  revealed: z.boolean(),
  submittedAt: IsoDateTimeSchema,
  questions: z.array(QuizQuestionResultSchema).min(1).max(QUIZ_LIMITS.maxQuestions),
});

function resultIsConsistent(r: z.infer<typeof QuizResultBaseSchema>): boolean {
  return (
    r.correctCount <= r.questionCount &&
    r.passed === r.scorePct >= r.passPct &&
    (r.revealed || r.questions.every((q) => q.correctOptions === null && q.explanationMd === null))
  );
}

const RESULT_CONSISTENCY = {
  message: 'passed follows scorePct/passPct, and nothing is revealed unless `revealed`',
  path: ['revealed'],
};

export const QuizResultSchema = QuizResultBaseSchema.refine(resultIsConsistent, RESULT_CONSISTENCY);
export type QuizResult = z.infer<typeof QuizResultSchema>;

/** `GET /me/quiz-attempts/:attemptId`: `result` is set exactly for SUBMITTED attempts. */
export const QuizAttemptDetailSchema = QuizAttemptBaseSchema.extend({
  result: QuizResultSchema.nullable(),
}).refine((a) => (a.status === 'SUBMITTED') === (a.result !== null), {
  message: 'result is set exactly for SUBMITTED attempts',
  path: ['result'],
});
export type QuizAttemptDetail = z.infer<typeof QuizAttemptDetailSchema>;

export const QuizAttemptSummarySchema = z.object({
  id: UuidSchema,
  lectureId: UuidSchema,
  revisionId: UuidSchema,
  status: QuizAttemptStatusSchema,
  scorePct: percent().nullable(),
  passed: z.boolean().nullable(),
  startedAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
});
export type QuizAttemptSummary = z.infer<typeof QuizAttemptSummarySchema>;

export const QuizAttemptPageSchema = pageSchema(QuizAttemptSummarySchema);
export type QuizAttemptPage = z.infer<typeof QuizAttemptPageSchema>;

export const QuizAttemptsQuerySchema = CompactPaginationQuerySchema;
export type QuizAttemptsQuery = z.output<typeof QuizAttemptsQuerySchema>;

/**
 * One entry per answered question; omitted questions count as wrong. Ids and positions are
 * checked against the attempt by the api (422 `quiz_answers_invalid`).
 */
export const QuizAnswerSchema = z.object({
  questionId: UuidSchema,
  optionPositions: z
    .array(QuizOptionPositionSchema)
    .max(QUIZ_LIMITS.maxOptions)
    .refine((p) => new Set(p).size === p.length, { message: 'Positions must be unique' }),
});
export type QuizAnswer = z.infer<typeof QuizAnswerSchema>;

export const SubmitQuizAttemptRequestSchema = z.object({
  answers: z
    .array(QuizAnswerSchema)
    .max(QUIZ_LIMITS.maxQuestions)
    .refine((a) => new Set(a.map((x) => x.questionId)).size === a.length, {
      message: 'Each question may be answered once',
    }),
});
export type SubmitQuizAttemptRequest = z.output<typeof SubmitQuizAttemptRequestSchema>;

/** The result plus the course state after a pass completed the lecture (in the same tx). */
export const SubmitQuizAttemptResponseSchema = QuizResultBaseSchema.extend({
  progress: ProgressAckSchema,
}).refine(resultIsConsistent, RESULT_CONSISTENCY);
export type SubmitQuizAttemptResponse = z.infer<typeof SubmitQuizAttemptResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * Certificates (D7):
 *   GET /me/certificates?cursor=&limit=          -> 200 CertificatePage (P certificate:read:own)
 *   GET /me/certificates/:certificateId          -> 200 Certificate     (Pol certificate:read; 404)
 *   GET /me/certificates/:certificateId/pdf      -> 200 SignedUrl       (404, 409 certificate_pdf_pending)
 *   GET /certificates/:code                      -> 200 CertificateVerification (public; 404, 429)
 *   GET /certificates/:code/pdf                  -> 200 SignedUrl (public, ACTIVE only; 404, 409, 429)
 * The PDF is a presigned GET (attachment, 15 min). Keyset (issuedAt DESC, id DESC).
 * -------------------------------------------------------------------------------------- */

export const CERTIFICATE_TRANSITION_ACTIONS = ['ISSUE', 'REVOKE', 'REINSTATE'] as const;
export const CertificateTransitionActionSchema = z.enum(CERTIFICATE_TRANSITION_ACTIONS);
export type CertificateTransitionAction = z.infer<typeof CertificateTransitionActionSchema>;

export const CERTIFICATE_TRANSITION_CAUSES = [
  'COURSE_COMPLETED',
  'ENROLLMENT_REVOKED',
  'ENROLLMENT_REGRANTED',
  'ADMIN',
] as const;
export const CertificateTransitionCauseSchema = z.enum(CERTIFICATE_TRANSITION_CAUSES);
export type CertificateTransitionCause = z.infer<typeof CertificateTransitionCauseSchema>;

export const CERTIFICATE_VERIFICATION_CACHE_CONTROL = 'private, max-age=60';

export const CertificateIdParamsSchema = z.object({ certificateId: UuidSchema });
export type CertificateIdParams = z.output<typeof CertificateIdParamsSchema>;

export const CertificateCodeParamsSchema = z.object({ code: CertificateCodeSchema });
export type CertificateCodeParams = z.output<typeof CertificateCodeParamsSchema>;

export const CertificateSchema = z
  .object({
    id: UuidSchema,
    code: CertificateCodeSchema,
    courseId: UuidSchema,
    /** For the landing link; null when the course no longer exists. */
    courseSlug: z.string().nullable(),
    /** Snapshots: what the certificate says (D7). */
    courseTitle: z.string(),
    recipientName: z.string(),
    instructorName: z.string(),
    status: CertificateStatusSchema,
    issuedAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
    /** The PDF was rendered (`pdf_rendered_at`); else the pdf route is 409. */
    pdfReady: z.boolean(),
  })
  .refine((c) => (c.status === 'REVOKED') === (c.revokedAt !== null), {
    message: 'revokedAt is set exactly for REVOKED certificates',
    path: ['revokedAt'],
  });
export type Certificate = z.infer<typeof CertificateSchema>;

export const CertificatePageSchema = pageSchema(CertificateSchema);
export type CertificatePage = z.infer<typeof CertificatePageSchema>;

export const MyCertificatesQuerySchema = CompactPaginationQuerySchema;
export type MyCertificatesQuery = z.output<typeof MyCertificatesQuerySchema>;

/** Public verification (`noindex`, `Referrer-Policy: no-referrer` on the page). */
export const CertificateVerificationSchema = z.object({
  code: CertificateCodeSchema,
  status: CertificateStatusSchema,
  recipientName: z.string(),
  courseTitle: z.string(),
  instructorName: z.string(),
  issuedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  /** Null when the course is no longer public. */
  courseSlug: z.string().nullable(),
  /** ACTIVE and rendered: the public pdf route will answer. */
  pdfAvailable: z.boolean(),
});
export type CertificateVerification = z.infer<typeof CertificateVerificationSchema>;

/* ----------------------------------------------------------------------------------------
 * Admin (admin BFF, P certificate:manage:any):
 *   GET  /admin/users/:userId/certificates               -> 200 AdminUserCertificates (404)
 *   POST /admin/certificates/:certificateId/revoke    {reason} -> 200 AdminCertificate
 *   POST /admin/certificates/:certificateId/reinstate {reason} -> 200 AdminCertificate
 *   (404 certificate_not_found, 409 invalid_state_transition)
 * -------------------------------------------------------------------------------------- */

export const CertificateTransitionSchema = z.object({
  id: UuidSchema,
  action: CertificateTransitionActionSchema,
  cause: CertificateTransitionCauseSchema,
  /** Set for ADMIN transitions. */
  actorId: UuidSchema.nullable(),
  actor: PersonRefSchema.nullable(),
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type CertificateTransition = z.infer<typeof CertificateTransitionSchema>;

export const AdminCertificateSchema = z.object({
  certificate: CertificateSchema,
  userId: UuidSchema,
  /** Oldest first. */
  transitions: z.array(CertificateTransitionSchema).min(1),
});
export type AdminCertificate = z.infer<typeof AdminCertificateSchema>;

export const AdminUserCertificatesSchema = z.object({ items: z.array(AdminCertificateSchema) });
export type AdminUserCertificates = z.infer<typeof AdminUserCertificatesSchema>;

/** Every admin certificate action carries a reason (10–2000, `certificate_transitions.reason`). */
export const AdminCertificateReasonRequestSchema = z.object({ reason: multilineText(10, 2000) });
export type AdminCertificateReasonRequest = z.output<typeof AdminCertificateReasonRequestSchema>;
