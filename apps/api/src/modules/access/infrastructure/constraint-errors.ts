import type { DomainError } from '@udemy/nest-common/errors';
import { RoleNotAssignable, UserNotFound } from '../domain/access.errors';

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

/** Constraint name -> domain error, per schema doc §6 (unknown violations stay 500s). */
type ToDomainError = (role: string, cause: unknown) => DomainError;
const userNotFound: ToDomainError = (_role, cause) => new UserNotFound({ cause });
const roleNotAssignable: ToDomainError = (role, cause) => new RoleNotAssignable(role, { cause });

const BY_CONSTRAINT: Readonly<Record<string, ToDomainError>> = {
  user_roles_user_id_fk: userNotFound,
  role_changes_user_id_fk: userNotFound,
  user_roles_role_code_role_is_implicit_fk: roleNotAssignable,
  user_roles_role_is_implicit_ck: roleNotAssignable,
  role_changes_role_code_role_is_implicit_fk: roleNotAssignable,
  role_changes_role_is_implicit_ck: roleNotAssignable,
};

/**
 * Re-throws a known constraint violation as its domain error (with the pg error as cause);
 * anything else is re-thrown unchanged.
 */
export function rethrowConstraintViolation(error: unknown, role: string): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toDomain = BY_CONSTRAINT[error.constraint];
    if (toDomain !== undefined) throw toDomain(role, error);
  }
  throw error;
}
