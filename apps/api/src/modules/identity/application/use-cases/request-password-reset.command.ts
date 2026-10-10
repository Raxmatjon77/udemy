import { Injectable, Logger } from '@nestjs/common';
import type { ClientContext } from '../../../../shared/auth';
import { RateLimiter } from '../../../../shared/redis';
import { Email } from '../../domain/email';
import { AUTH_RATE_LIMITS, forgotLimiterKeys } from '../auth-rate-limits';
import { clientFields } from '../client-fields';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { LoginEmailHasher } from '../ports/login-email.hasher';
import { ResponseTimeFloor } from '../ports/response-time-floor';
import { SecurityEventLog } from '../ports/security-event.log';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

/**
 * Minimum duration of every forgot-password request (design §8/§9): the unknown-email, the
 * rate-limited and the mail-requested paths all answer after the same floor.
 */
export const FORGOT_PASSWORD_RESPONSE_FLOOR_MS = 400;

export interface RequestPasswordResetInput {
  readonly email: string;
  readonly client: ClientContext;
}

export type RequestPasswordResetOutcome = 'requested' | 'unknown_email' | 'rate_limited';

/**
 * `RequestPasswordReset` (design §5). The controller always answers 202; this use case
 * returns what happened for logs and tests only.
 *
 * - `rl:forgot:e:{emailHmac}` (3 / h) and `rl:forgot:ip:{ip}` (10 / h) count every request,
 *   whether or not the account exists. Over either limit the request is dropped silently.
 * - Known account: `PasswordResetRequested` (+ PASSWORD_RESET_REQUESTED security event) in one
 *   transaction under the per-user lock, `requestedAt` = SQL `now()`. The worker issues the
 *   token and mails the link (D10); the api never creates a raw token.
 *
 * @throws InvalidEmail 422 only for a malformed address (independent of any account)
 */
@Injectable()
export class RequestPasswordResetCommand {
  private readonly logger = new Logger(RequestPasswordResetCommand.name);

  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly events: IdentityEventPublisher,
    private readonly securityLog: SecurityEventLog,
    private readonly emailHasher: LoginEmailHasher,
    private readonly limiter: RateLimiter,
    private readonly tx: TransactionRunner,
    private readonly floor: ResponseTimeFloor,
  ) {}

  async execute(input: RequestPasswordResetInput): Promise<RequestPasswordResetOutcome> {
    const email = Email.parse(input.email);
    return this.floor.run(FORGOT_PASSWORD_RESPONSE_FLOOR_MS, async () => {
      const keys = forgotLimiterKeys(
        this.emailHasher.hash(email.value).toString('hex'),
        input.client.ip,
      );
      const [perEmail, perIp] = await Promise.all([
        this.limiter.hit(keys.email, AUTH_RATE_LIMITS.forgotEmail),
        this.limiter.hit(keys.ip, AUTH_RATE_LIMITS.forgotIp),
      ]);
      if (perEmail.limited || perIp.limited) {
        this.logger.log(
          { limiter: perEmail.limited ? 'email' : 'ip' },
          'Forgot-password request dropped (rate limit)',
        );
        return 'rate_limited';
      }

      const account = await this.accounts.findByEmail(email.value);
      if (account === null) return 'unknown_email';

      const requested = await this.tx.run(async (trx) => {
        const locked = await this.accounts.lockAccount(trx, account.id);
        if (locked === null) return false;
        await this.events.passwordResetRequested(trx, {
          userId: locked.id,
          email: locked.email,
          displayName: locked.displayName,
          requestedAt: locked.now.toISOString(),
        });
        await this.securityLog.record(
          { type: 'PASSWORD_RESET_REQUESTED', userId: locked.id, ...clientFields(input.client) },
          trx,
        );
        return true;
      });
      return requested ? 'requested' : 'unknown_email';
    });
  }
}
