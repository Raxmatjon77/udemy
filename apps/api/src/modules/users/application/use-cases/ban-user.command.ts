import { Injectable } from '@nestjs/common';
import type { BanRecord as BanRecordView } from '@udemy/contracts';
import { AccessFacade } from '../../../access';
import { CannotBanSelf, IdentityFacade } from '../../../identity';
import { TargetIsAdmin, UserNotFound } from '../../domain/users.errors';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserLock } from '../ports/user-lock';
import { toBanView } from '../views';

export interface BanUserInput {
  readonly actorId: string;
  readonly userId: string;
  /** 10–1000 chars. */
  readonly reason: string;
}

/**
 * `BanUser` (admin, design §5). In one transaction:
 *
 * 1. take the per-user mutex (schema doc §6) and, while holding it, refuse ADMIN holders
 *    (409 `target_is_admin`). `AccessFacade.grantRole` takes the same lock, so a concurrent
 *    "grant ADMIN" either committed before (we see the role) or waits until we commit;
 * 2. `IdentityFacade.banUser`: ban row, revoke all sessions, `UserBanned`, security event and
 *    the Redis sid keys, written BEFORE the commit (ban ordering: a Redis failure aborts).
 *
 * Errors: 409 `cannot_ban_self` / `target_is_admin` / `already_banned`, 404 `user_not_found`.
 */
@Injectable()
export class BanUserCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly lock: UserLock,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: BanUserInput): Promise<BanRecordView> {
    if (input.actorId === input.userId) throw new CannotBanSelf();
    return this.tx.run(async (trx) => {
      if (!(await this.lock.lock(trx, input.userId))) throw new UserNotFound();
      if (await this.access.hasRole(input.userId, 'ADMIN', trx)) throw new TargetIsAdmin();
      const ban = await this.identity.banUser(trx, {
        userId: input.userId,
        actorId: input.actorId,
        reason: input.reason,
      });
      return toBanView(ban);
    });
  }
}
