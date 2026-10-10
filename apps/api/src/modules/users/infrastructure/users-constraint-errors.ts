import {
  ApplicationAlreadyPending,
  InvalidStateTransition,
  SelfDecisionForbidden,
  UserNotFound,
} from '../domain/users.errors';

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

/**
 * Constraint name -> domain error for the `users` tables (schema doc §6; for unique indexes
 * `err.constraint` is the index name). Anything not listed (other CHECKs, the deferred
 * `instructor_applications_status_log_ck` at COMMIT, 42501 from the append-only guards) stays
 * a 500: it is a programming error.
 */
export const USERS_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // One PENDING application per applicant (a concurrent submit lost the race).
  instructor_applications_applicant_id_pending_uq: (cause) =>
    new ApplicationAlreadyPending({ cause }),
  // Each state reached / left at most once; only legal edges (double or crossed decisions).
  ia_transitions_application_id_to_status_uq: (cause) => new InvalidStateTransition({ cause }),
  ia_transitions_application_id_from_status_uq: (cause) => new InvalidStateTransition({ cause }),
  ia_transitions_edge_ck: (cause) => new InvalidStateTransition({ cause }),
  // Raised by the ia_transitions_actor_trg trigger (an applicant deciding their own application).
  ia_transitions_actor_ck: (cause) => new SelfDecisionForbidden({ cause }),
  // Rows pointing at a user that does not exist.
  profiles_user_id_fk: (cause) => new UserNotFound({ cause }),
  instructor_applications_applicant_id_fk: (cause) => new UserNotFound({ cause }),
  ia_transitions_actor_id_fk: (cause) => new UserNotFound({ cause }),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowUsersConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = USERS_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapUsersConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowUsersConstraint(error);
  }
}
