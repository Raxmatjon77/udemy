import type { DB, Executor, Transaction } from '@udemy/db';
import type { BanRecord } from '../dto';

/** `identity.user_bans`. Constraint violations surface as domain errors. */
export abstract class UserBanRepository {
  abstract findActive(userId: string, ex?: Executor): Promise<BanRecord | null>;

  /** Newest first. */
  abstract list(userId: string, ex?: Executor): Promise<BanRecord[]>;

  /**
   * @throws AlreadyBanned (`user_bans_user_id_active_uq`), CannotBanSelf
   *   (`user_bans_banned_by_ck`), AccountNotFound (FK)
   */
  abstract insert(
    trx: Transaction<DB>,
    ban: { userId: string; bannedBy: string; reason: string },
  ): Promise<BanRecord>;

  /** `UPDATE ... WHERE user_id = $1 AND lifted_at IS NULL RETURNING`; null = no active ban. */
  abstract lift(
    trx: Transaction<DB>,
    lift: { userId: string; liftedBy: string; liftReason: string | null },
  ): Promise<BanRecord | null>;
}
