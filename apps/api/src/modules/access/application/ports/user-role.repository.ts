import type { Executor, Transaction, DB } from '@udemy/db';
import type { AssignableRole } from '../../domain/role';

export interface RoleChangeRecord {
  readonly userId: string;
  readonly role: AssignableRole;
  readonly change: 'GRANTED' | 'REVOKED';
  /** null only for the CLI bootstrap grant. */
  readonly actorId: string | null;
  readonly reason: string;
  /** Grants always carry a source; revokes carry none. */
  readonly sourceType: 'instructor_application' | 'cli_bootstrap' | 'admin' | null;
  readonly sourceId: string | null;
}

/**
 * Port for `access.user_roles` / `access.role_changes` (implemented with Kysely in
 * infrastructure). Read methods use the root database when no executor is given.
 * Constraint violations surface as domain errors (UserNotFound, RoleNotAssignable).
 */
export abstract class UserRoleRepository {
  /**
   * Per-user mutex (schema doc §6): `SELECT id FROM identity.users WHERE id = $1 FOR NO KEY UPDATE`.
   * Returns false when the user does not exist.
   */
  abstract lockUser(trx: Transaction<DB>, userId: string): Promise<boolean>;

  abstract findRoles(userId: string, ex?: Executor): Promise<AssignableRole[]>;

  abstract findRolesForUsers(
    userIds: readonly string[],
    ex?: Executor,
  ): Promise<Map<string, AssignableRole[]>>;

  abstract findUserIdsWithRole(role: AssignableRole, ex?: Executor): Promise<string[]>;

  /** INSERT ... ON CONFLICT DO NOTHING RETURNING: null when the user already held the role. */
  abstract insertUserRole(
    trx: Transaction<DB>,
    userId: string,
    role: AssignableRole,
  ): Promise<{ grantedAt: Date } | null>;

  /** DELETE ... RETURNING: null when the user did not hold the role. */
  abstract deleteUserRole(
    trx: Transaction<DB>,
    userId: string,
    role: AssignableRole,
  ): Promise<{ revokedAt: Date } | null>;

  /** Appends to the history table; returns the SQL `now()` of the row. */
  abstract insertRoleChange(
    trx: Transaction<DB>,
    record: RoleChangeRecord,
  ): Promise<{ id: string; occurredAt: Date }>;
}
