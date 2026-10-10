import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { UserLock } from '../application/ports/user-lock';

@Injectable()
export class KyselyUserLock extends UserLock {
  async lock(trx: Transaction<DB>, userId: string): Promise<boolean> {
    // Shared-kernel exception (D12), as in access's KyselyUserRoleRepository.lockUser:
    // identity.users is used only as the per-user lock target, never read for data.
    // FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE locks of FK checks.
    const row = await trx
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }
}
