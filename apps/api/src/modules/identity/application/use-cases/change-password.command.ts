import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../../../shared/auth';
import { Email } from '../../domain/email';
import { InvalidCurrentPassword } from '../../domain/identity.errors';
import { PlainPassword } from '../../domain/password/plain-password';
import { clientFields } from '../client-fields';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { OneTimeTokenRepository } from '../ports/one-time-token.repository';
import { PasswordHasher } from '../ports/password-hasher';
import { SecurityEventLog } from '../ports/security-event.log';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { SessionRepository } from '../ports/session.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

export interface ChangePasswordInput {
  readonly principal: Principal;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly client: ClientContext;
}

/**
 * `ChangePassword` (design §5): verifies the current password (Argon2, outside the
 * transaction), checks and hashes the new one, then under the per-user lock: re-checks that
 * the stored hash did not change meanwhile, sets the new hash and `password_changed_at`,
 * invalidates every live reset token (§9: "all reset tokens are invalidated on any password
 * change"), revokes every OTHER session (`PASSWORD_CHANGED`, Redis sid keys before the
 * commit), writes PASSWORD_CHANGED and emits `PasswordChanged{via:CHANGE}`. The calling
 * session stays signed in.
 *
 * @throws InvalidCurrentPassword 400, WeakPassword 422
 */
@Injectable()
export class ChangePasswordCommand {
  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly tokens: OneTimeTokenRepository,
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly events: IdentityEventPublisher,
    private readonly revocations: SessionRevocationStore,
    private readonly hasher: PasswordHasher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: ChangePasswordInput): Promise<{ revokedCount: number }> {
    const { principal } = input;
    const account = await this.accounts.findById(principal.userId);
    if (account === null) throw new InvalidCurrentPassword();
    if (!(await this.hasher.verify(account.passwordHash, input.currentPassword))) {
      throw new InvalidCurrentPassword();
    }
    const password = PlainPassword.create(input.newPassword, {
      email: Email.parse(account.email),
      field: 'newPassword',
    });
    const passwordHash = await this.hasher.hash(password);

    return this.tx.run(async (trx) => {
      const locked = await this.accounts.lockAccount(trx, account.id);
      // Changed concurrently (another change or a reset): the verified password is stale.
      if (locked === null || locked.passwordHash !== account.passwordHash) {
        throw new InvalidCurrentPassword();
      }
      const changedAt = await this.accounts.changePassword(trx, locked.id, passwordHash);
      await this.tokens.invalidateLive(trx, locked.id, 'PASSWORD_RESET');
      const revoked = await this.sessions.revokeOthersForUser(
        trx,
        locked.id,
        principal.sessionId,
        'PASSWORD_CHANGED',
      );
      await this.securityLog.record(
        {
          type: 'PASSWORD_CHANGED',
          userId: locked.id,
          sessionId: principal.sessionId,
          ...clientFields(input.client),
          metadata: { via: 'CHANGE', revokedCount: revoked.length },
        },
        trx,
      );
      await this.events.passwordChanged(trx, {
        userId: locked.id,
        via: 'CHANGE',
        changedAt: changedAt.toISOString(),
      });
      await this.revocations.revokeMany(revoked);
      return { revokedCount: revoked.length };
    });
  }
}
