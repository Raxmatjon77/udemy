import {
  InvalidEnrollmentReason,
  InvalidStateTransition,
  UserNotFound,
} from '../domain/enrollment.errors';

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
 * Constraint name -> domain error for the `enrollment` tables (schema doc §9). Not listed, so
 * a 500 (programming errors, logged by the global filter): `enrollments_status_log_ck`
 * (deferred, at COMMIT), `enrollments_immutable_ck`, the other `enrollments_*_ck` shape CHECKs,
 * `enrollment_transitions_source_ck` / `_revoke_ck` / `_root_ck`, the actor FK and 42501 from
 * the append-only guards. `enrollments_user_id_course_id_uq` never surfaces: the grant upsert
 * handles it.
 */
export const ENROLLMENT_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // A concurrent transition took the same seq (impossible under the row lock; logged as cause).
  enrollment_transitions_pk: (cause) => new InvalidStateTransition(undefined, { cause }),
  // Illegal edges and a stale from_status (the linear chain FK).
  enrollment_transitions_edge_ck: (cause) => new InvalidStateTransition(undefined, { cause }),
  enrollment_transitions_enrollment_id_prev_seq_from_status_fk: (cause) =>
    new InvalidStateTransition(undefined, { cause }),
  // Admin actions: actor + reason of >= 10 characters (the request schema checks first).
  enrollment_transitions_admin_ck: (cause) => new InvalidEnrollmentReason({ cause }),
  enrollment_transitions_reason_ck: (cause) => new InvalidEnrollmentReason({ cause }),
  // An enrollment for a user that does not exist.
  enrollments_user_id_fk: (cause) => new UserNotFound({ cause }),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowEnrollmentConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = ENROLLMENT_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapEnrollmentConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowEnrollmentConstraint(error);
  }
}
