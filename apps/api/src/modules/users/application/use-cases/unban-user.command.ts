import { Injectable } from '@nestjs/common';
import type { BanRecord as BanRecordView } from '@udemy/contracts';
import { IdentityFacade } from '../../../identity';
import { TransactionRunner } from '../ports/transaction-runner';
import { toBanView } from '../views';

export interface UnbanUserInput {
  readonly actorId: string;
  readonly userId: string;
  /** Optional, 1–1000 chars. */
  readonly reason?: string;
}

/**
 * `UnbanUser` (admin, design §5): lifts the active ban (`UserUnbanned`); revoked sessions stay
 * revoked. Returns the lifted ban. Errors: 404 `user_not_found`, 409 `not_banned`.
 */
@Injectable()
export class UnbanUserCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UnbanUserInput): Promise<BanRecordView> {
    return this.tx.run(async (trx) =>
      toBanView(
        await this.identity.unbanUser(trx, {
          userId: input.userId,
          actorId: input.actorId,
          reason: input.reason,
        }),
      ),
    );
  }
}
