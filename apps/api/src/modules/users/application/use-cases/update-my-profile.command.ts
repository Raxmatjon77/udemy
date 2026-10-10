import { Injectable } from '@nestjs/common';
import type { Profile as ProfileView } from '@udemy/contracts';
import { IdentityFacade } from '../../../identity';
import { Profile } from '../../domain/profile';
import { InvalidUsersField, UserNotFound } from '../../domain/users.errors';
import { ProfileRepository } from '../ports/profile.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toProfileView } from '../views';

export interface UpdateMyProfileInput {
  readonly userId: string;
  readonly displayName?: string;
  /** `null` clears. */
  readonly headline?: string | null;
  /** `null` clears. */
  readonly bio?: string | null;
}

/**
 * `UpdateMyProfile` (design §5): the display name goes through
 * `IdentityFacade.changeDisplayName` (identity owns it, D8; emits DisplayNameChanged) and the
 * profile row is upserted (lazy creation), all in ONE transaction.
 */
@Injectable()
export class UpdateMyProfileCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly profiles: ProfileRepository,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpdateMyProfileInput): Promise<ProfileView> {
    const changes = Profile.parseChanges(input);
    if (input.displayName === undefined && !Profile.hasChanges(changes)) {
      throw new InvalidUsersField({
        path: '',
        message: 'At least one of displayName, headline or bio is required.',
      });
    }
    return this.tx.run(async (trx) => {
      if (input.displayName !== undefined) {
        await this.identity.changeDisplayName(trx, {
          userId: input.userId,
          displayName: input.displayName,
        });
      }
      const profile = Profile.hasChanges(changes)
        ? await this.profiles.upsert(trx, input.userId, changes)
        : ((await this.profiles.find(input.userId, trx)) ?? Profile.defaults(input.userId));
      const user = await this.identity.getUserSummary(input.userId, trx);
      if (user === null) throw new UserNotFound();
      return toProfileView(profile, user.displayName);
    });
  }
}
