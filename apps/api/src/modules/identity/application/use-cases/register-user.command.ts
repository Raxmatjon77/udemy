import { Injectable, Logger } from '@nestjs/common';
import type { ClientContext } from '../../../../shared/auth';
import { RateLimiter } from '../../../../shared/redis';
import { DisplayName } from '../../domain/display-name';
import { Email } from '../../domain/email';
import { ClientNotAllowed, SignupRateLimited } from '../../domain/identity.errors';
import { PlainPassword } from '../../domain/password/plain-password';
import { AUTH_RATE_LIMITS, signupExistingNoticeKey, signupIpKey } from '../auth-rate-limits';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { PasswordHasher } from '../ports/password-hasher';
import { ResponseTimeFloor } from '../ports/response-time-floor';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

/**
 * Minimum duration of every accepted signup (design §9 "Enumeration and timing"). Both paths
 * pay one Argon2 hash; the floor hides the rest (insert + two outbox rows vs. a Redis check).
 */
export const SIGNUP_RESPONSE_FLOOR_MS = 400;

export interface RegisterUserInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly client: ClientContext;
}

/**
 * `RegisterUser` (design §5). Student app only. Always answers `{ accepted: true }` for a
 * well-formed request, whether or not the email already has an account:
 *
 * - new email: insert the account + `UserRegistered` + `EmailVerificationRequested{SIGNUP}`
 *   in one transaction;
 * - existing email: hash anyway (timing), then emit `SignupAttemptedForExistingEmail` at most
 *   once per 24 h per user (`rl:signup-existing-notice:u:{uid}`), so the owner gets a
 *   "you already have an account" mail and nobody learns anything from the response.
 *
 * @throws ClientNotAllowed 403, SignupRateLimited 429, WeakPassword 422, InvalidEmail /
 *   InvalidDisplayName 422 (all independent of whether the email exists)
 */
@Injectable()
export class RegisterUserCommand {
  private readonly logger = new Logger(RegisterUserCommand.name);

  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly events: IdentityEventPublisher,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly tx: TransactionRunner,
    private readonly floor: ResponseTimeFloor,
  ) {}

  async execute(input: RegisterUserInput): Promise<{ accepted: true }> {
    if (input.client.app !== 'student') throw new ClientNotAllowed();

    const limit = await this.limiter.hit(signupIpKey(input.client.ip), AUTH_RATE_LIMITS.signupIp);
    if (limit.limited) throw new SignupRateLimited(limit.ttlMs);

    const email = Email.parse(input.email);
    const displayName = DisplayName.parse(input.displayName);
    const password = PlainPassword.create(input.password, { email });

    return this.floor.run(SIGNUP_RESPONSE_FLOOR_MS, async () => {
      // Hashed on both paths: an existing email must cost the same Argon2 work.
      const passwordHash = await this.hasher.hash(password);
      const created = await this.tx.run(async (trx) => {
        const inserted = await this.accounts.insertIfAbsent(trx, {
          email: email.value,
          displayName: displayName.value,
          passwordHash,
          emailVerified: false,
        });
        if (inserted === null) return false;
        const at = inserted.createdAt.toISOString();
        await this.events.userRegistered(trx, {
          userId: inserted.id,
          email: email.value,
          displayName: displayName.value,
          registeredAt: at,
        });
        await this.events.emailVerificationRequested(trx, {
          userId: inserted.id,
          email: email.value,
          displayName: displayName.value,
          reason: 'SIGNUP',
          requestedAt: at,
        });
        return true;
      });
      if (!created) await this.noticeExistingAccount(email);
      return { accepted: true as const };
    });
  }

  private async noticeExistingAccount(email: Email): Promise<void> {
    const existing = await this.accounts.findByEmail(email.value);
    if (existing === null) return; // deleted in between: nothing to tell anyone
    const notice = await this.limiter.hit(
      signupExistingNoticeKey(existing.id),
      AUTH_RATE_LIMITS.signupExistingNotice,
    );
    if (notice.limited) {
      this.logger.debug(
        { userId: existing.id },
        'Signup for an existing email; notice already sent',
      );
      return;
    }
    await this.tx.run((trx) =>
      this.events.signupAttemptedForExistingEmail(trx, {
        userId: existing.id,
        email: existing.email,
        displayName: existing.displayName,
        attemptedAt: new Date().toISOString(),
      }),
    );
  }
}
