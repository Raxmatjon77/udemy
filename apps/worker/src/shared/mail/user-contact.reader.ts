import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

export interface UserContact {
  readonly email: string;
  readonly displayName: string;
}

/**
 * Current address and display name of a user (`identity.users`), for notices whose event carries
 * only the userId. Read inside the handler's transaction; null when the account no longer exists.
 */
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
