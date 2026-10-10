import type { RoleGrantSource } from '@udemy/contracts';
import type { Role } from '../domain/role';

export interface GrantRoleCommand {
  readonly userId: string;
  /** Typed as any Role so STUDENT is rejected at runtime with RoleNotAssignable. */
  readonly role: Role;
  /** null only with `source: { type: 'cli_bootstrap' }`. */
  readonly actorId: string | null;
  readonly reason: string;
  readonly source: RoleGrantSource;
}

export interface RevokeRoleCommand {
  readonly userId: string;
  readonly role: Role;
  readonly actorId: string;
  readonly reason: string;
}

/** `changed: false` = the user already had (grant) / did not have (revoke) the role. */
export interface RoleChangeResult {
  readonly changed: boolean;
}

/** Result of a resource-level check. NOT_FOUND is answered as 404 (no ID probing). */
export type AuthorizationDecision = 'ALLOW' | 'DENY' | 'NOT_FOUND';
