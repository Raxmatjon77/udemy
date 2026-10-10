import { ASSIGNABLE_ROLES, type AssignableRole, type Role, ROLES } from '@udemy/contracts';

/**
 * Roles come from the shared contracts (one definition for api, worker and the web apps).
 * STUDENT is implicit (design D5): every active account holds it by construction and it is
 * never stored in `access.user_roles`. Only INSTRUCTOR and ADMIN are assignable.
 */
export type { AssignableRole, Role };
export { ASSIGNABLE_ROLES, ROLES };

/** The role every account holds without a stored grant. */
export const IMPLICIT_ROLE = 'STUDENT' as const satisfies Role;

const ASSIGNABLE: ReadonlySet<string> = new Set(ASSIGNABLE_ROLES);

export function isAssignableRole(role: string): role is AssignableRole {
  return ASSIGNABLE.has(role);
}

/**
 * Adds the implicit STUDENT and returns the roles de-duplicated in canonical order
 * (STUDENT, INSTRUCTOR, ADMIN), so callers and tokens always see a stable list.
 */
export function withImplicitRole(roles: Iterable<Role>): Role[] {
  const held = new Set<Role>(roles);
  held.add(IMPLICIT_ROLE);
  return ROLES.filter((role) => held.has(role));
}
