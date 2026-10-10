import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

export interface AdminRecipient {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Every ADMIN (design §7: "reads `access.user_roles` + `identity.users`"), minus admins with an
 * active ban, ordered by id so retries walk the same order. Read in the handler's transaction.
 */
@Injectable()
export class AdminRecipientsReader {
  async list(trx: Transaction<DB>): Promise<AdminRecipient[]> {
    return trx
      .selectFrom('access.userRoles as r')
      .innerJoin('identity.users as u', 'u.id', 'r.userId')
      .select(['u.id as userId', 'u.email', 'u.displayName'])
      .where('r.roleCode', '=', 'ADMIN')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('identity.userBans as b')
              .select('b.id')
              .whereRef('b.userId', '=', 'u.id')
              .where('b.liftedAt', 'is', null),
          ),
        ),
      )
      .orderBy('u.id')
      .execute();
  }
}
