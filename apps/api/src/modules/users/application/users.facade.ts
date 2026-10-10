import { Injectable } from '@nestjs/common';
import type { PublicProfile } from '@udemy/contracts';
import { PublicProfileReader } from './public-profile.reader';

/**
 * Public API of the users context for other modules (design §3), e.g. the Phase 2 course
 * instructor card and reviews. Banned and unknown users have no public profile.
 */
@Injectable()
export class UsersFacade {
  constructor(private readonly reader: PublicProfileReader) {}

  /** The public profile, or null for an unknown or banned user. */
  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    return (await this.reader.read([userId]))[0] ?? null;
  }

  /** Public profiles of the visible users among `userIds`, in request order (no duplicates). */
  getPublicProfiles(userIds: readonly string[]): Promise<PublicProfile[]> {
    return this.reader.read(userIds);
  }
}
