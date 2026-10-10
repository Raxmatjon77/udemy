import type { ClientApp, Permission, Role } from '@udemy/contracts';

/**
 * Effective permissions of a principal (design D6): baseline + permissions of the roles
 * allowed in `app`. A port so the authenticator is testable without the access module;
 * bound to `AccessFacade.effectivePermissions` by AccessPermissionResolver.
 */
export abstract class PermissionResolver {
  abstract effectivePermissions(roles: readonly Role[], app: ClientApp): ReadonlySet<Permission>;
}
