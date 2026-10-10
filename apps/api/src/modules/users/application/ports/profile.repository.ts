import type { DB, Executor, Transaction } from '@udemy/db';
import type { ProfileChanges, ProfileState } from '../../domain/profile';

/** Port for `users.profiles`. Reads use the root database when no executor is given. */
export abstract class ProfileRepository {
  abstract find(userId: string, ex?: Executor): Promise<ProfileState | null>;

  abstract findMany(userIds: readonly string[], ex?: Executor): Promise<ProfileState[]>;

  /**
   * `INSERT ... ON CONFLICT (user_id) DO UPDATE` of the given fields only (lazy creation).
   * @throws UserNotFound when the user does not exist (FK)
   */
  abstract upsert(
    trx: Transaction<DB>,
    userId: string,
    changes: ProfileChanges,
  ): Promise<ProfileState>;
}
