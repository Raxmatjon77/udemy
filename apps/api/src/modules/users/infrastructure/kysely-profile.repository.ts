import { Injectable } from '@nestjs/common';
import type { DB, Executor, Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ProfileRepository } from '../application/ports/profile.repository';
import type { ProfileChanges, ProfileState } from '../domain/profile';
import { mapUsersConstraints } from './users-constraint-errors';

const COLUMNS = ['userId', 'headline', 'bio', 'avatarMediaId'] as const;

@Injectable()
export class KyselyProfileRepository extends ProfileRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async find(userId: string, ex: Executor = this.db): Promise<ProfileState | null> {
    const row = await ex
      .selectFrom('users.profiles')
      .select(COLUMNS)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row ?? null;
  }

  async findMany(userIds: readonly string[], ex: Executor = this.db): Promise<ProfileState[]> {
    if (userIds.length === 0) return [];
    return ex
      .selectFrom('users.profiles')
      .select(COLUMNS)
      .where('userId', 'in', [...userIds])
      .execute();
  }

  upsert(trx: Transaction<DB>, userId: string, changes: ProfileChanges): Promise<ProfileState> {
    const set = {
      ...(changes.headline === undefined ? {} : { headline: changes.headline }),
      ...(changes.bio === undefined ? {} : { bio: changes.bio }),
    };
    return mapUsersConstraints(() =>
      trx
        .insertInto('users.profiles')
        .values({ userId, headline: changes.headline ?? null, bio: changes.bio ?? null })
        .onConflict((oc) => oc.column('userId').doUpdateSet(set))
        .returning(COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }
}
