import { Injectable, Logger } from '@nestjs/common';
import type { ClientContext } from '../../../../shared/auth';
import { Email } from '../../domain/email';
import { InvalidOneTimeToken } from '../../domain/identity.errors';
import {
  checkOneTimeToken,
  hashOneTimeToken,
  type OneTimeTokenRejection,
} from '../../domain/one-time-token';
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

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
  readonly client: ClientContext;
}

type Outcome =
  | { readonly kind: 'reset'; readonly revokedCount: number }
  | { readonly kind: 'rejected'; readonly cause: OneTimeTokenRejection | 'unknown_token' };

/**
 * `ResetPassword` (design §5):
 *
 * 1. SHA-256 of the token, unlocked lookup and cheap checks (so a dead link never costs an
 *    Argon2 hash); the new password is checked against the policy and hashed outside the
 *    transaction.
 * 2. One transaction, per-user lock (user row, then token row), every check repeated against
 *    SQL `now()`: purpose PASSWORD_RESET, not consumed/invalidated/expired, token email = the
 *    current email.
 * 3. Consume the token, invalidate every other live reset token, set the hash and
 *    `password_changed_at`, mark the email verified (the token proved control of the current
 *    address), revoke ALL sessions (`PASSWORD_RESET`) with their Redis sid keys set before the
 *    commit, write PASSWORD_CHANGED and emit `PasswordChanged{via:RESET}`.
 *
 * @throws InvalidOneTimeToken 400 `invalid_token`, WeakPassword 422
 */
@Injectable()
export class ResetPasswordCommand {
  private readonly logger = new Logger(ResetPasswordCommand.name);

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

  async execute(input: ResetPasswordInput): Promise<void> {
    const tokenHash = hashOneTimeToken(input.token);
    const found = await this.tokens.findByHash(tokenHash);
    const account = found === null ? null : await this.accounts.findById(found.userId);
    if (found === null || account === null) {
      return this.reject({ kind: 'rejected', cause: 'unknown_token' });
    }
    // Pre-check without the clock (expiry is decided inside the transaction).
    const early = checkOneTimeToken(found, {
      purpose: 'PASSWORD_RESET',
      currentEmail: account.email,
      now: new Date(0),
    });
    if (early !== null) return this.reject({ kind: 'rejected', cause: early }, found.userId);

    const password = PlainPassword.create(input.newPassword, {
      email: Email.parse(account.email),
      field: 'newPassword',
    });
    const passwordHash = await this.hasher.hash(password);

    const outcome = await this.tx.run(async (trx): Promise<Outcome> => {
      const locked = await this.accounts.lockAccount(trx, found.userId);
      const token = await this.tokens.lockByHash(trx, tokenHash);
      if (locked === null || token === null) return { kind: 'rejected', cause: 'unknown_token' };
      const rejection = checkOneTimeToken(token, {
        purpose: 'PASSWORD_RESET',
        currentEmail: locked.email,
        now: locked.now,
      });
      if (rejection !== null) return { kind: 'rejected', cause: rejection };

      await this.tokens.consume(trx, token.id);
      await this.tokens.invalidateLive(trx, locked.id, 'PASSWORD_RESET');
      const changedAt = await this.accounts.changePassword(trx, locked.id, passwordHash);
      const verifiedAt = await this.accounts.markEmailVerified(trx, locked.id);
      if (verifiedAt !== null) {
        await this.securityLog.record(
          { type: 'EMAIL_VERIFIED', userId: locked.id, metadata: { via: 'PASSWORD_RESET' } },
          trx,
        );
        await this.events.emailVerified(trx, {
          userId: locked.id,
          email: locked.email,
          verifiedAt: verifiedAt.toISOString(),
        });
      }

      const revoked = await this.sessions.revokeAllForUser(trx, locked.id, 'PASSWORD_RESET');
      await this.securityLog.record(
        {
          type: 'PASSWORD_CHANGED',
          userId: locked.id,
          ...clientFields(input.client),
          metadata: { via: 'RESET', revokedCount: revoked.length },
        },
        trx,
      );
      await this.events.passwordChanged(trx, {
        userId: locked.id,
        via: 'RESET',
        changedAt: changedAt.toISOString(),
      });
      // Before the commit (fail closed): if Redis is down the reset rolls back with a 503.
      await this.revocations.revokeMany(revoked);
      return { kind: 'reset', revokedCount: revoked.length };
    });
    if (outcome.kind === 'rejected') return this.reject(outcome, found.userId);
  }

  private reject(outcome: Extract<Outcome, { kind: 'rejected' }>, userId?: string): never {
    this.logger.log({ userId, cause: outcome.cause }, 'Password reset token refused');
    throw new InvalidOneTimeToken();
  }
}
