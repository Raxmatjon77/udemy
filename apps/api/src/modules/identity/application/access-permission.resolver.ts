import { Injectable } from '@nestjs/common';
import type { ClientApp, Permission, Role } from '@udemy/contracts';
import { AccessFacade } from '../../access';
import { PermissionResolver } from './ports/permission-resolver';

/** Binds the identity PermissionResolver port to the access module (design §3, D6). */
@Injectable()
export class AccessPermissionResolver extends PermissionResolver {
  constructor(private readonly access: AccessFacade) {
    super();
  }

  effectivePermissions(roles: readonly Role[], app: ClientApp): ReadonlySet<Permission> {
    return this.access.effectivePermissions(roles, app);
  }
}
