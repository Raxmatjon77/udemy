import { Injectable } from '@nestjs/common';
import { isPermission, type Permission } from '@udemy/contracts';
import type { PolicyAction, PolicyResource, Principal } from '../../../shared/auth';
import type { AuthorizationDecision } from './access.types';
import { OwnershipRegistry } from './ownership.registry';

/** The parts of a principal an authorization decision depends on. */
export type AuthorizationSubject = Pick<Principal, 'userId' | 'permissions'>;

/**
 * Authorization decisions for HTTP (PoliciesGuard) and non-HTTP callers (use cases,
 * worker, CLI). Permissions are already app-scoped on the principal (design D6).
 */
@Injectable()
export class Authorizer {
  constructor(private readonly ownership: OwnershipRegistry) {}

  can(principal: AuthorizationSubject, permission: Permission): boolean {
    return principal.permissions.has(permission);
  }

  /**
   * Design §4 policy semantics:
   * - `<resource>:<action>:any` held: ALLOW without loading the resource (the use case
   *   answers 404 if it does not exist);
   * - else `<resource>:<action>:own` held: ask the resource's OwnershipResolver. Missing
   *   resource or another owner: NOT_FOUND (404, never 403, so ids cannot be probed);
   * - else DENY (403).
   *
   * @throws Error when `:own` applies but no module registered a resolver (programming error)
   */
  async canOnResource<R extends PolicyResource>(
    principal: AuthorizationSubject,
    action: PolicyAction<R>,
    resourceType: R,
    resourceId: string,
  ): Promise<AuthorizationDecision> {
    const base = `${resourceType}:${action}`;
    if (this.holds(principal, `${base}:any`)) return 'ALLOW';
    if (!this.holds(principal, `${base}:own`)) return 'DENY';

    if (resourceId.length === 0) return 'NOT_FOUND';
    const resolver = this.ownership.get(resourceType);
    if (resolver === undefined) {
      throw new Error(`No @OwnershipResolverFor('${resourceType}') provider is registered`);
    }
    const owner = await resolver.ownerOf(resourceId);
    return owner !== null && owner === principal.userId ? 'ALLOW' : 'NOT_FOUND';
  }

  private holds(principal: AuthorizationSubject, permission: string): boolean {
    return isPermission(permission) && principal.permissions.has(permission);
  }
}
