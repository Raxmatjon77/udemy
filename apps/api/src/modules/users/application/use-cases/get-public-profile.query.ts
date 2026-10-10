import { Injectable } from '@nestjs/common';
import type { PublicProfile } from '@udemy/contracts';
import { UserNotFound } from '../../domain/users.errors';
import { PublicProfileReader } from '../public-profile.reader';

/** `GetPublicProfile` (design §5): 404 `user_not_found` for unknown AND banned users. */
@Injectable()
export class GetPublicProfileQuery {
  constructor(private readonly reader: PublicProfileReader) {}

  async execute(userId: string): Promise<PublicProfile> {
    const profile = (await this.reader.read([userId]))[0];
    if (profile === undefined) throw new UserNotFound();
    return profile;
  }
}
