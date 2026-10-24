import {
  AnnouncementNotFound,
  AnswerNotFound,
  CannotReportOwnContent,
  CannotVoteOwnContent,
  InvalidEngagementInput,
  InvalidModerationTransition,
  QuestionNotFound,
  ReplyNotFound,
  ReviewNotFound,
} from '../domain/engagement.errors';

interface PgErrorLike {
  code: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

type ToDomainError = (cause: unknown) => Error;

const invalid: ToDomainError = (cause) => new InvalidEngagementInput({ cause });
const ownContent: ToDomainError = (cause) => new CannotReportOwnContent({ cause });
const ownVote: ToDomainError = (cause) => new CannotVoteOwnContent({ cause });
const question404: ToDomainError = (cause) => new QuestionNotFound({ cause });
const answer404: ToDomainError = (cause) => new AnswerNotFound({ cause });
const transition: ToDomainError = (cause) => new InvalidModerationTransition({ cause });

/**
 * Constraint name -> domain error for the review, reply, Q&A, vote, announcement, wishlist and
 * report tables (schema doc §9 "Engagement"). Not listed, so a 500 (programming errors, logged
 * by the global filter): `moderation_status_log_ck` / `moderation_actions_subject_ck`
 * (deferred, at COMMIT), the counter guards (`questions_counters_ck`, `answers_counters_ck`:
 * the app never writes counters), the user FKs and 42501 from the append-only guards. The live
 * uniques and the vote / wishlist / report uniques never surface: the upserts and
 * `ON CONFLICT DO NOTHING` handle them.
 */
export const ENGAGEMENT_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // Shapes the request schemas already enforce (rating 1-5, trimmed plain text, lengths)
  reviews_rating_ck: invalid,
  reviews_body_ck: invalid,
  review_replies_body_ck: invalid,
  review_reports_reason_ck: invalid,
  review_reports_comment_ck: invalid,
  review_reply_reports_reason_ck: invalid,
  review_reply_reports_comment_ck: invalid,
  moderation_actions_reason_ck: invalid,
  // A write on a review/reply that was deleted meanwhile (a deleted row is frozen)
  reviews_immutable_ck: (cause) => new ReviewNotFound({ cause }),
  review_replies_immutable_ck: (cause) => new ReplyNotFound({ cause }),
  review_replies_review_id_fk: (cause) => new ReviewNotFound({ cause }),
  // "Not your own" backstop of the report tables (the use case checks first)
  review_reports_own_content_ck: ownContent,
  review_reply_reports_own_content_ck: ownContent,
  // The subject row vanished (reports reference it with a real FK)
  review_reports_subject_id_fk: (cause) => new ReviewNotFound({ cause }),
  review_reply_reports_subject_id_fk: (cause) => new ReplyNotFound({ cause }),

  // Q&A content and announcements (the request schemas check the shapes first)
  questions_title_ck: invalid,
  questions_body_md_ck: invalid,
  answers_body_md_ck: invalid,
  announcements_title_ck: invalid,
  announcements_body_md_ck: invalid,
  question_reports_reason_ck: invalid,
  question_reports_comment_ck: invalid,
  answer_reports_reason_ck: invalid,
  answer_reports_comment_ck: invalid,
  // A write on a question/answer/announcement deleted meanwhile (deleted content is frozen)
  questions_immutable_ck: question404,
  answers_immutable_ck: answer404,
  announcements_immutable_ck: (cause) => new AnnouncementNotFound({ cause }),
  // The accepted answer must be a visible answer of the question (composite FK + guard)
  questions_id_accepted_answer_id_fk: answer404,
  questions_accepted_answer_visible_ck: answer404,
  answers_question_id_fk: question404,
  // Votes: not your own (the use case checks first); the subject vanished
  question_votes_own_content_ck: ownVote,
  answer_votes_own_content_ck: ownVote,
  question_votes_subject_id_fk: question404,
  answer_votes_subject_id_fk: answer404,
  // Reports on Q&A
  question_reports_own_content_ck: ownContent,
  answer_reports_own_content_ck: ownContent,
  question_reports_subject_id_fk: question404,
  answer_reports_subject_id_fk: answer404,
  // A report resolved twice (two admins racing; the db ops only move OPEN reports)
  review_reports_transition_ck: transition,
  review_reply_reports_transition_ck: transition,
  question_reports_transition_ck: transition,
  answer_reports_transition_ck: transition,
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowEngagementConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = ENGAGEMENT_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapEngagementConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowEngagementConstraint(error);
  }
}
