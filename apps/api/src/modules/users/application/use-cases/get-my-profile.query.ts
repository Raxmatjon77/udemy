import { Injectable } from '@nestjs/common';
import type { Profile as ProfileView } from '@udemy/contracts';
import { IdentityFacade } from '../../../identity';
import { Profile } from '../../domain/profile';
import { UserNotFound } from '../../domain/users.errors';
import { ProfileRepository } from '../ports/profile.repository';
import { toProfileView } from '../views';

/** `GetMyProfile` (design §5): defaults until the first PATCH creates the row. */
@Injectable()
export class GetMyProfileQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly profiles: ProfileRepository,
  ) {}

  async execute(userId: string): Promise<ProfileView> {
    const [user, profile] = await Promise.all([
      this.identity.getUserSummary(userId),
      this.profiles.find(userId),
    ]);
    if (user === null) throw new UserNotFound();
    return toProfileView(profile ?? Profile.defaults(userId), user.displayName);
  }
}
