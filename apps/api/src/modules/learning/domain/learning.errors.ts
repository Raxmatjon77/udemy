import { ErrorCode } from '@udemy/contracts';
import {
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/* ----------------------------------------------------------------------------------------
 * The common learner rule (design §5): 404 first, then 403.
 * -------------------------------------------------------------------------------------- */

/** 404 `course_not_found`: no live revision (never published, or deleted). */
export class CourseNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course does not exist.', { code: ErrorCode.CourseNotFound, cause: options.cause });
  }
}

/** 404 `lecture_not_found`: the lecture is not part of the course's live revision. */
export class LectureNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The lecture does not exist in this course.', {
      code: ErrorCode.LectureNotFound,
      cause: options.cause,
    });
  }
}

/**
 * 403 `enrollment_required`: no ACTIVE enrollment (never enrolled, refunded, revoked), or the
 * owner trying to write from the read-only PREVIEW. The outline is public, so this reveals
 * nothing the landing page does not.
 */
export class EnrollmentRequired extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('An active enrollment in this course is required.', {
      code: ErrorCode.EnrollmentRequired,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Business rules (422)
 * -------------------------------------------------------------------------------------- */

/** 422 `lecture_type_mismatch`: progress for a lecture that is not a VIDEO with a duration. */
export class LectureTypeMismatch extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Progress can only be recorded for video lectures.', {
      code: ErrorCode.LectureTypeMismatch,
      cause: options.cause,
    });
  }
}

/**
 * 422 `completion_not_allowed`: manual completion of a VIDEO or QUIZ (the server measures
 * those), or a cause that does not match the lecture type (D4, P5-D3).
 */
export class CompletionNotAllowed extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('This lecture cannot be completed this way.', {
      code: ErrorCode.CompletionNotAllowed,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Infrastructure (503)
 * -------------------------------------------------------------------------------------- */

/**
 * 503: the progress buffer could not apply a heartbeat (Redis unavailable, or the per-lecture
 * compare-and-set kept losing to concurrent heartbeats). The player keeps the batch and
 * retries later (a 429 would make it drop the batch).
 */
export class ProgressStoreUnavailable extends DependencyUnavailableError {
  constructor(options: CauseOption = {}) {
    super('learning-progress-store', options);
  }
}

/* ----------------------------------------------------------------------------------------
 * Notes (P5-T11)
 * -------------------------------------------------------------------------------------- */

/** 404 `note_not_found`: unknown, or another learner's note (never 403, ids cannot be probed). */
export class NoteNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The note does not exist.', { code: ErrorCode.NoteNotFound, cause: options.cause });
  }
}

/** 422 `note_limit_exceeded`: 500 notes per (user, course) (`LEARNING_LIMITS.maxNotesPerCourse`). */
export class NoteLimitExceeded extends ValidationError {
  constructor(limit: number) {
    super(`A course can hold at most ${limit} notes.`, { code: ErrorCode.NoteLimitExceeded });
  }
}

/**
 * 422 `validation_failed` on `positionSeconds`: a timestamp on a lecture that is not a video of
 * the live revision, or beyond its duration.
 */
export class NotePositionInvalid extends ValidationError {
  constructor() {
    super('A timestamp is only allowed within the duration of a video lecture.', {
      code: ErrorCode.ValidationFailed,
      issues: [
        { path: 'positionSeconds', message: 'Only within the duration of a video lecture.' },
      ],
    });
  }
}

/** One offending markdown construct (`@udemy/markdown/validate`). */
export interface LearningMarkdownIssue {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
  readonly construct: string;
  readonly detail: string;
}

/** 422 `markdown_not_allowed`: raw HTML, images or unsafe links in a note body (D22). */
export class MarkdownNotAllowed extends ValidationError {
  readonly markdownIssues: readonly LearningMarkdownIssue[];

  constructor(markdownIssues: readonly LearningMarkdownIssue[]) {
    super('The text contains markdown that is not allowed (HTML, images or unsafe links).', {
      code: ErrorCode.MarkdownNotAllowed,
      issues: markdownIssues.map((issue) => ({
        path: issue.path,
        message: `Line ${issue.line}, column ${issue.column}: ${issue.detail} (${issue.kind}).`,
      })),
    });
    this.markdownIssues = markdownIssues;
  }
}

/* ----------------------------------------------------------------------------------------
 * Quiz attempts (P5-T11, D6)
 * -------------------------------------------------------------------------------------- */

/** 422 `lecture_type_mismatch`: quiz attempts exist only for QUIZ lectures. */
export class QuizLectureRequired extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Only quiz lectures have attempts.', {
      code: ErrorCode.LectureTypeMismatch,
      cause: options.cause,
    });
  }
}

/** 404 `quiz_attempt_not_found`: unknown, or another learner's attempt. */
export class QuizAttemptNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The quiz attempt does not exist.', {
      code: ErrorCode.QuizAttemptNotFound,
      cause: options.cause,
    });
  }
}

/** 409 `attempt_not_in_progress`: the attempt was ABANDONED (stale, or a newer revision went live). */
export class AttemptNotInProgress extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The quiz attempt is no longer in progress. Start a new attempt.', {
      code: ErrorCode.AttemptNotInProgress,
      cause: options.cause,
    });
  }
}

/**
 * 422 `quiz_answers_invalid`: a question id that is not part of the attempt, an option position
 * out of range, or more than one selection on a single-choice question.
 */
export class QuizAnswersInvalid extends ValidationError {
  constructor(message: string, options: CauseOption = {}) {
    super(message, { code: ErrorCode.QuizAnswersInvalid, cause: options.cause });
  }
}

/* ----------------------------------------------------------------------------------------
 * Certificates (P5-T11, D7)
 * -------------------------------------------------------------------------------------- */

/** 404 `certificate_not_found`: unknown id/code, another learner's, or a revoked public PDF. */
export class CertificateNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The certificate does not exist.', {
      code: ErrorCode.CertificateNotFound,
      cause: options.cause,
    });
  }
}

/** 409 `certificate_pdf_pending`: issued, but the worker has not rendered the PDF yet. */
export class CertificatePdfPending extends ConflictError {
  constructor() {
    super('The certificate PDF is being prepared. Please try again in a few minutes.', {
      code: ErrorCode.CertificatePdfPending,
    });
  }
}

/** 409 `invalid_state_transition`: revoking a REVOKED or reinstating an ACTIVE certificate. */
export class CertificateTransitionNotAllowed extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The certificate is already in that state.', {
      code: ErrorCode.InvalidStateTransition,
      cause: options.cause,
    });
  }
}

/** 404 `user_not_found`: the admin certificates tab of an unknown user. */
export class UserNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The user does not exist.', { code: ErrorCode.UserNotFound, cause: options.cause });
  }
}
