import { ConcurrentRotation } from '../../application/use-cases/refresh-session.command';
import {
  AccountNotFound,
  AlreadyBanned,
  CannotBanSelf,
  EmailAlreadyRegistered,
} from '../../domain/identity.errors';

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
 * Constraint name -> error, for the identity tables (schema doc §6 "Constraint names -> domain
 * errors"; for unique indexes `err.constraint` is the index name). Anything not listed (other
 * CHECKs, 42501 from the append-only guards) stays a 500: it is a programming error.
 */
export const IDENTITY_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // Signup turns this into the generic 202 path; provisioning into `created: false`.
  users_email_uq: (cause) => new EmailAlreadyRegistered({ cause }),
  // One active ban per user.
  user_bans_user_id_active_uq: (cause) => new AlreadyBanned({ cause }),
  user_bans_banned_by_ck: (cause) => new CannotBanSelf({ cause }),
  // Rows pointing at a user that does not exist.
  user_bans_user_id_fk: (cause) => new AccountNotFound({ cause }),
  user_bans_banned_by_fk: (cause) => new AccountNotFound({ cause }),
  user_bans_lifted_by_fk: (cause) => new AccountNotFound({ cause }),
  sessions_user_id_fk: (cause) => new AccountNotFound({ cause }),
  security_events_user_id_fk: (cause) => new AccountNotFound({ cause }),
  // A concurrent rotation of the same refresh token won: retry, which takes the grace path.
  refresh_tokens_parent_id_uq: (cause) => new ConcurrentRotation({ cause }),
  refresh_tokens_session_id_current_uq: (cause) => new ConcurrentRotation({ cause }),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowIdentityConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = IDENTITY_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapIdentityConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowIdentityConstraint(error);
  }
}
