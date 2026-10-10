import type { DB, Transaction } from '@udemy/db';

/**
 * The per-user mutex of schema doc §6 (`SELECT ... FROM identity.users WHERE id = $1
 * FOR NO KEY UPDATE`), shared with ban/unban, grantRole/revokeRole and the password writers.
 * BanUser holds it while it checks "target is not an ADMIN", which closes the ban-vs-grant race.
 */
export abstract class UserLock {
  /** Locks the user's row until the transaction ends; false when the user does not exist. */
  abstract lock(trx: Transaction<DB>, userId: string): Promise<boolean>;
}
