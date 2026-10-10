import { Injectable } from '@nestjs/common';
import type { AdminUserDetail } from '@udemy/contracts';
import { AccessFacade } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { UserNotFound } from '../../domain/users.errors';
import { toAdminUserSummary, toBanView } from '../views';

/** `AdminGetUser` (design §5): summary + roles + ban history + active session count. */
@Injectable()
export class AdminGetUserQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
  ) {}

  async execute(userId: string): Promise<AdminUserDetail> {
    const user = await this.identity.getUserSummary(userId);
    if (user === null) throw new UserNotFound();
    const [roles, bans, activeSessionCount] = await Promise.all([
      this.access.getRoles(userId),
      this.identity.listBans(userId),
      this.identity.countActiveSessions(userId),
    ]);
    return {
      user: toAdminUserSummary(user),
      roles,
      bans: bans.map(toBanView),
      activeSessionCount,
    };
  }
}
