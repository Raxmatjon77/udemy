import { Injectable } from '@nestjs/common';
import type { PublicProfile } from '@udemy/contracts';
import { AccessFacade } from '../../access';
import { IdentityFacade } from '../../identity';
import { Profile } from '../domain/profile';
import { ProfileRepository } from './ports/profile.repository';
import { toPublicProfile } from './views';

/**
 * Batched public profiles (GetPublicProfile, UsersFacade): one query each for the accounts,
 * the profiles and the roles, whatever the number of ids. Unknown and banned users are left
 * out (design §5: a banned user's public profile is 404).
 */
@Injectable()
export class PublicProfileReader {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly profiles: ProfileRepository,
  ) {}

  /** In the order of `userIds` (duplicates collapsed), visible users only. */
  async read(userIds: readonly string[]): Promise<PublicProfile[]> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    const users = (await this.identity.getUserSummaries(ids)).filter(
      (user) => user.status === 'ACTIVE',
    );
    if (users.length === 0) return [];
    const visibleIds = users.map((user) => user.id);
    const [profiles, roles] = await Promise.all([
      this.profiles.findMany(visibleIds),
      this.access.getRolesForUsers(visibleIds),
    ]);
    const profileById = new Map(profiles.map((p) => [p.userId, p]));
    const userById = new Map(users.map((u) => [u.id, u]));
    return ids.flatMap((id) => {
      const user = userById.get(id);
      if (user === undefined) return [];
      const profile = profileById.get(id) ?? Profile.defaults(id);
      return [toPublicProfile(user, profile, (roles.get(id) ?? []).includes('INSTRUCTOR'))];
    });
  }
}
