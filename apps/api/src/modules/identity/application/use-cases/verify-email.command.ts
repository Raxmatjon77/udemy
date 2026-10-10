import { Injectable, Logger } from '@nestjs/common';
import {
  checkOneTimeToken,
  hashOneTimeToken,
  type OneTimeTokenRejection,
  sameEmail,
} from '../../domain/one-time-token';
import { InvalidOneTimeToken } from '../../domain/identity.errors';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { OneTimeTokenRepository } from '../ports/one-time-token.repository';
import { SecurityEventLog } from '../ports/security-event.log';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

type Outcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'already_done' }
  | { readonly kind: 'rejected'; readonly cause: OneTimeTokenRejection | 'unknown_token' };

/**
 * `VerifyEmail` (design §5): the presented token is hashed with SHA-256 and looked up. It must
 * be an EMAIL_VERIFICATION token that is neither consumed nor invalidated nor expired (SQL
 * `now()`), and its email must still be the account's email. Then, in one transaction under
 * the per-user lock (user row, then token row): consume the token, set `email_verified_at`,
 * write EMAIL_VERIFIED and emit `EmailVerified`.
 *
 * Idempotent: a consumed token whose email is the account's current, verified email succeeds
 * again (a double click or a retried request answers 204, not 400).
 *
 * @throws InvalidOneTimeToken 400 `invalid_token` for every failure cause (only logged)
 */
@Injectable()
export class VerifyEmailCommand {
  private readonly logger = new Logger(VerifyEmailCommand.name);

  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly tokens: OneTimeTokenRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly events: IdentityEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: { readonly token: string }): Promise<void> {
    const tokenHash = hashOneTimeToken(input.token);
    const found = await this.tokens.findByHash(tokenHash);
    if (found === null) return this.reject({ kind: 'rejected', cause: 'unknown_token' });

    const outcome = await this.tx.run(async (trx): Promise<Outcome> => {
      const account = await this.accounts.lockAccount(trx, found.userId);
      const token = await this.tokens.lockByHash(trx, tokenHash);
      if (account === null || token === null) return { kind: 'rejected', cause: 'unknown_token' };

      if (
        token.purpose === 'EMAIL_VERIFICATION' &&
        token.consumedAt !== null &&
        account.emailVerifiedAt !== null &&
        sameEmail(token.email, account.email)
      ) {
        return { kind: 'already_done' };
      }
      const rejection = checkOneTimeToken(token, {
        purpose: 'EMAIL_VERIFICATION',
        currentEmail: account.email,
        now: account.now,
      });
      if (rejection !== null) return { kind: 'rejected', cause: rejection };

      await this.tokens.consume(trx, token.id);
      const verifiedAt = await this.accounts.markEmailVerified(trx, account.id);
      // Already verified by other means (a password reset): the token is used up, nothing else.
      if (verifiedAt === null) return { kind: 'already_done' };
      await this.securityLog.record({ type: 'EMAIL_VERIFIED', userId: account.id }, trx);
      await this.events.emailVerified(trx, {
        userId: account.id,
        email: account.email,
        verifiedAt: verifiedAt.toISOString(),
      });
      return { kind: 'verified' };
    });
    if (outcome.kind === 'rejected') return this.reject(outcome, found.userId);
  }

  private reject(outcome: Extract<Outcome, { kind: 'rejected' }>, userId?: string): never {
    this.logger.log({ userId, cause: outcome.cause }, 'Email verification token refused');
    throw new InvalidOneTimeToken();
  }
}
