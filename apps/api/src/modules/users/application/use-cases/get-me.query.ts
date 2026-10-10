import { Injectable } from '@nestjs/common';
import type { MeResponse } from '@udemy/contracts';
import type { Principal } from '../../../../shared/auth';
import { AccessFacade } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { Profile } from '../../domain/profile';
import { UserNotFound } from '../../domain/users.errors';
import { ProfileRepository } from '../ports/profile.repository';

/**
 * `GetMe` (design §5). `roles` is the current state (so the student app sees an approval at
 * once, without waiting for a token refresh); `permissions` and `app` are what THIS access
 * token is authorized for (app-scoped, design D6), i.e. exactly what the API enforces.
 */
@Injectable()
export class GetMeQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly profiles: ProfileRepository,
  ) {}

  async execute(principal: Principal): Promise<MeResponse> {
    const [user, roles, profile] = await Promise.all([
      this.identity.getUserSummary(principal.userId),
      this.access.getRoles(principal.userId),
      this.profiles.find(principal.userId),
    ]);
    if (user === null) throw new UserNotFound();
    const current = profile ?? Profile.defaults(principal.userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      roles,
      permissions: [...principal.permissions].sort(),
      app: principal.app,
      profile: { headline: current.headline, bio: current.bio, avatarUrl: null },
    };
  }
}
