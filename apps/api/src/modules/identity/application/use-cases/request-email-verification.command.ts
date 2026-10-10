import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../../shared/auth';
import { RateLimiter } from '../../../../shared/redis';
import {
  AccountNotFound,
  EmailAlreadyVerified,
  VerificationRateLimited,
} from '../../domain/identity.errors';
import { AUTH_RATE_LIMITS, verifyResendKey } from '../auth-rate-limits';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

/**
 * `RequestEmailVerification` (design §5): emits `EmailVerificationRequested{reason:RESEND}` to
 * the outbox. The worker issues the token and sends the mail (D10); the api never creates a
 * raw token.
 *
 * A verified address answers 409 before anything is counted; then `rl:verify-resend:u:{uid}`
 * (3 / h) applies. The event is written under the per-user lock with SQL `now()` as
 * `requestedAt`, so `requested_at` order equals commit (= Kafka) order for one user.
 *
 * @throws EmailAlreadyVerified 409, VerificationRateLimited 429
 */
@Injectable()
export class RequestEmailVerificationCommand {
  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly events: IdentityEventPublisher,
    private readonly limiter: RateLimiter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(principal: Principal): Promise<void> {
    const account = await this.accounts.findById(principal.userId);
    if (account === null) throw new AccountNotFound();
    if (account.emailVerifiedAt !== null) throw new EmailAlreadyVerified();

    const limit = await this.limiter.hit(
      verifyResendKey(principal.userId),
      AUTH_RATE_LIMITS.verifyResend,
    );
    if (limit.limited) throw new VerificationRateLimited(limit.ttlMs);

    await this.tx.run(async (trx) => {
      const locked = await this.accounts.lockAccount(trx, principal.userId);
      if (locked === null) throw new AccountNotFound();
      if (locked.emailVerifiedAt !== null) throw new EmailAlreadyVerified();
      await this.events.emailVerificationRequested(trx, {
        userId: locked.id,
        email: locked.email,
        displayName: locked.displayName,
        reason: 'RESEND',
        requestedAt: locked.now.toISOString(),
      });
    });
  }
}
