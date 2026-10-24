import {
  CannotReportOwnContent,
  InvalidEngagementInput,
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

/**
 * Constraint name -> domain error for the review, reply, wishlist and report tables (schema doc
 * §9 "Engagement"). P5-T13 adds the Q&A and announcement rows. Not listed, so a 500 (programming
 * errors, logged by the global filter): `moderation_status_log_ck` / `moderation_actions_subject_ck`
 * (deferred, at COMMIT), the user FKs, `*_reports_transition_ck` (the db ops only move OPEN
 * reports) and 42501 from the append-only guards. The live uniques and the wishlist / report
 * uniques never surface: the upserts and `ON CONFLICT DO NOTHING` handle them.
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
