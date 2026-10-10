import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

export interface UserContact {
  readonly email: string;
  readonly displayName: string;
}

/** Current address and name of a user, for notices whose event carries only the userId. */
@Injectable()
export class UserContactReader {
  async find(trx: Transaction<DB>, userId: string): Promise<UserContact | null> {
    const row = await trx
      .selectFrom('identity.users')
      .select(['email', 'displayName'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return row ?? null;
  }
}
