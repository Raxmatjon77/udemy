import { Injectable } from '@nestjs/common';
import type { AccountStatus, AdminUserPage, AssignableRole } from '@udemy/contracts';
import { AccessFacade } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { toAdminUserRow } from '../views';

export interface AdminSearchUsersInput {
  readonly q?: string;
  readonly status?: AccountStatus;
  readonly role?: AssignableRole;
  readonly cursor?: string;
  /** 1..100. */
  readonly limit: number;
}

/**
 * `AdminSearchUsers` (design §5): newest first, keyset paginated. A role filter is resolved
 * through `AccessFacade.listUserIdsWithRole` and passed as `idIn` to
 * `IdentityFacade.searchUsers` (module boundary: no cross-schema join, schema doc §6). The
 * roles of the page come from one `getRolesForUsers` call.
 */
@Injectable()
export class AdminSearchUsersQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  async execute(input: AdminSearchUsersInput): Promise<AdminUserPage> {
    const idIn =
      input.role === undefined ? undefined : await this.access.listUserIdsWithRole(input.role);
    const page = await this.identity.searchUsers({
      q: input.q,
      status: input.status,
      idIn,
      cursor: input.cursor,
      limit: input.limit,
    });
    const roles = await this.access.getRolesForUsers(page.items.map((user) => user.id));
    return {
      items: page.items.map((user) => toAdminUserRow(user, roles.get(user.id) ?? ['STUDENT'])),
      nextCursor: page.nextCursor,
    };
  }
}
