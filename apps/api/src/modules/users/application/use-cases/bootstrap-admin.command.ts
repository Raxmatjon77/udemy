import { Injectable } from '@nestjs/common';
import { AccessFacade } from '../../../access';
import { IdentityFacade } from '../../../identity';
import { TransactionRunner } from '../ports/transaction-runner';

export interface BootstrapAdminInput {
  readonly email: string;
  readonly displayName: string;
  /** Checked against the PlainPassword policy (422 `weak_password`); never logged. */
  readonly password: string;
}

export interface BootstrapAdminResult {
  readonly userId: string;
  /** false: the account already existed (its password and name are left untouched). */
  readonly created: boolean;
  /** false: the account already held ADMIN. */
  readonly granted: boolean;
}

export const BOOTSTRAP_GRANT_REASON = 'Bootstrap admin (CLI admin:bootstrap)';

/**
 * `BootstrapAdmin` (design §5, CLI only): idempotent ensure-admin in ONE transaction.
 * Provisions a verified account when the email is unknown (`IdentityFacade.provisionAccount`),
 * then grants ADMIN with `actorId = null` and `source { type: 'cli_bootstrap' }`.
 * Re-running it is a no-op: `{ created: false, granted: false }`.
 */
@Injectable()
export class BootstrapAdminCommand {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly access: AccessFacade,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
    return this.tx.run(async (trx) => {
      const account = await this.identity.provisionAccount(trx, {
        email: input.email,
        displayName: input.displayName,
        password: input.password,
        emailVerified: true,
      });
      const grant = await this.access.grantRole(trx, {
        userId: account.userId,
        role: 'ADMIN',
        actorId: null,
        reason: BOOTSTRAP_GRANT_REASON,
        source: { type: 'cli_bootstrap' },
      });
      return { userId: account.userId, created: account.created, granted: grant.changed };
    });
  }
}
