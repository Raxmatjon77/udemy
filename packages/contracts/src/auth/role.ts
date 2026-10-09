import { z } from 'zod';

/**
 * Every role a user can hold. STUDENT is implicit: every active user holds it by
 * construction and it is never stored in `access.user_roles` (design D5).
 */
export const ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Roles that can be granted/revoked explicitly (everything except the implicit STUDENT). */
export const ASSIGNABLE_ROLES = ['INSTRUCTOR', 'ADMIN'] as const satisfies readonly Role[];
export const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES);
export type AssignableRole = z.infer<typeof AssignableRoleSchema>;
