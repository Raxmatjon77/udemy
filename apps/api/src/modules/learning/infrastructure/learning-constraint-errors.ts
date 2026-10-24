import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import {
  AttemptNotInProgress,
  CertificateTransitionNotAllowed,
  CompletionNotAllowed,
  QuizAnswersInvalid,
} from '../domain/learning.errors';

interface PgErrorLike {
  code: string;
  constraint?: string;
}

/** A node-pg error (SQLSTATE in `code`). */
export function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** SQLSTATE 23514 (check_violation). */
export function isCheckViolation(error: unknown): boolean {
  return isPgError(error) && error.code === '23514';
}

type ToDomainError = (cause: unknown) => Error;

/**
 * Constraint name -> domain error for the `learning` progress/completion tables (schema doc §9).
 * Not listed, so a 500 (programming errors, logged by the global filter): the
 * `lecture_progress_*_ck` shape CHECKs on the direct store (the flush drops such rows instead),
 * `lecture_completions_quiz_*`, the `_immutable_ck` guards and 42501 from append-only guards.
 * `lecture_completions_pk` / `course_completions_pk` never surface (ON CONFLICT DO NOTHING).
 */
export const LEARNING_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // The app validates the cause against the type first (contracts LECTURE_COMPLETION_CAUSES_BY_TYPE).
  lecture_completions_cause_type_ck: (cause) => new CompletionNotAllowed({ cause }),

  // Notes (P5-T11): the app validates first; these are the backstops.
  notes_body_md_ck: (cause) => invalidField('bodyMd', cause),
  notes_position_seconds_ck: (cause) => invalidField('positionSeconds', cause),

  // Quiz attempts (P5-T11): the app validates the answers first.
  quiz_attempt_selections_pk: (cause) => new QuizAnswersInvalid('Duplicate selection.', { cause }),
  quiz_attempt_selections_attempt_id_question_id_fk: (cause) =>
    new QuizAnswersInvalid('An answer refers to a question that is not part of this attempt.', {
      cause,
    }),
  quiz_attempt_selections_option_position_ck: (cause) =>
    new QuizAnswersInvalid('An option position is out of range.', { cause }),
  quiz_attempt_selections_attempt_open_ck: (cause) => new AttemptNotInProgress({ cause }),

  // Certificates (P5-T11, admin transitions): a concurrent transition won.
  certificate_transitions_pk: (cause) => new CertificateTransitionNotAllowed({ cause }),
  certificate_transitions_edge_ck: (cause) => new CertificateTransitionNotAllowed({ cause }),
  certificate_transitions_certificate_id_prev_seq_from_status_fk: (cause) =>
    new CertificateTransitionNotAllowed({ cause }),
  certificate_transitions_reason_ck: (cause) => invalidField('reason', cause),
};

function invalidField(path: string, cause: unknown): ValidationError {
  return new ValidationError('The request is invalid.', {
    code: ErrorCode.ValidationFailed,
    cause,
    issues: [{ path, message: 'Invalid value.' }],
  });
}

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowLearningConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = LEARNING_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}
