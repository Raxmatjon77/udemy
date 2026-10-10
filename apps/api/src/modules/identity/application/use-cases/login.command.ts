import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@udemy/contracts';
import type { ClientContext } from '../../../../shared/auth';
import { type RateLimitResult, RateLimiter } from '../../../../shared/redis';
import { AccessFacade } from '../../../access';
import { Email } from '../../domain/email';
import {
  AccountBanned,
  AppAccessDenied,
  InvalidCredentials,
  InvalidEmail,
  TooManyAttempts,
} from '../../domain/identity.errors';
import { sessionLifetime } from '../../domain/session';
import { AUTH_RATE_LIMITS, loginLimiterKeys } from '../auth-rate-limits';
import { clientFields } from '../client-fields';
import { AccessTokenIssuer } from '../ports/access-token-issuer';
import { LoginEmailHasher } from '../ports/login-email.hasher';
import { PasswordHasher } from '../ports/password-hasher';
import { RefreshTokenCodec } from '../ports/refresh-token.codec';
import { SecurityEventLog } from '../ports/security-event.log';
import { SessionRepository } from '../ports/session.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { type AccountRecord, UserAccountRepository } from '../ports/user-account.repository';
import { UserBanRepository } from '../ports/user-ban.repository';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly client: ClientContext;
}

/** `AuthResult` of design §8 (dates are serialised by the controller). */
export interface LoginResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly emailVerified: boolean;
    readonly roles: Role[];
  };
}

/** Normalises like the Email VO; an address the VO refuses can have no account. */
function normalizeLoginEmail(raw: string): { value: string; valid: boolean } {
  try {
    return { value: Email.parse(raw).value, valid: true };
  } catch (error) {
    if (!(error instanceof InvalidEmail)) throw error;
    return { value: raw.trim().normalize('NFKC').toLowerCase(), valid: false };
  }
}

type SessionOutcome =
  | {
      readonly kind: 'created';
      readonly sessionId: string;
      readonly refreshToken: string;
      readonly refreshExpiresAt: Date;
      readonly roles: Role[];
    }
  | { readonly kind: 'banned' }
  | { readonly kind: 'app_access_denied' };

/**
 * `Login` (design §5, §9). Order of checks:
 *
 * 1. `rl:login:ip:{ip}` counts every attempt (30 / 10 min); then the per email+IP (5 / 15 min)
 *    and per email (50 / 1 h) failure counters are checked without counting. All three are
 *    keyed by the HMAC of the normalised email, identical for existing and unknown accounts.
 * 2. The password is verified; an unknown email runs `dummyVerify` (same Argon2 cost).
 * 3. A failure counts on both failure counters and answers 401 `invalid_credentials`.
 * 4. Only after a correct password: 403 `account_banned`, then 403 `app_access_denied`.
 *    Both are re-checked inside the session transaction under a `FOR SHARE` lock on the user
 *    row, which serialises with ban/role changes (they take `FOR NO KEY UPDATE`): a ban either
 *    sees and revokes the new session, or this login sees the ban.
 * 5. Session + first refresh token (per-app idle/absolute TTLs) + LOGIN_SUCCEEDED, and an
 *    Argon2 rehash when the parameters changed, in one transaction; then the access token.
 *
 * Unverified accounts may log in (design §13).
 */
@Injectable()
export class LoginCommand {
  private readonly logger = new Logger(LoginCommand.name);

  constructor(
    private readonly accounts: UserAccountRepository,
    private readonly bans: UserBanRepository,
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly hasher: PasswordHasher,
    private readonly emailHasher: LoginEmailHasher,
    private readonly refreshTokens: RefreshTokenCodec,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly access: AccessFacade,
    private readonly limiter: RateLimiter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const { client } = input;
    const email = normalizeLoginEmail(input.email);
    const emailHash = this.emailHasher.hash(email.value);
    const keys = loginLimiterKeys(emailHash.toString('hex'), client.ip);

    // 1. Rate limits (fail closed: Redis down -> 503 before any password work).
    const perIp = await this.limiter.hit(keys.ip, AUTH_RATE_LIMITS.loginIp);
    if (perIp.limited) return this.throttled(client, emailHash, 'ip', perIp);
    const [perEmailIp, perEmail] = await Promise.all([
      this.limiter.peek(keys.emailIp, AUTH_RATE_LIMITS.loginEmailIp),
      this.limiter.peek(keys.email, AUTH_RATE_LIMITS.loginEmail),
    ]);
    if (perEmailIp.limited) return this.throttled(client, emailHash, 'email_ip', perEmailIp);
    if (perEmail.limited) return this.throttled(client, emailHash, 'email', perEmail);

    // 2. Verify (same Argon2 cost for unknown emails).
    const account = email.valid ? await this.accounts.findByEmail(email.value) : null;
    const verified =
      account === null
        ? await this.hasher.dummyVerify(input.password)
        : await this.hasher.verify(account.passwordHash, input.password);

    // 3. Failure: count it, log it, one generic answer.
    if (account === null || !verified) {
      await Promise.all([
        this.limiter.hit(keys.emailIp, AUTH_RATE_LIMITS.loginEmailIp),
        this.limiter.hit(keys.email, AUTH_RATE_LIMITS.loginEmail),
      ]);
      await this.securityLog.record({
        type: 'LOGIN_FAILED',
        userId: account?.id ?? null,
        emailHash: account === null ? emailHash : null,
        ...clientFields(client),
        metadata: { cause: account === null ? 'unknown_email' : 'wrong_password' },
      });
      throw new InvalidCredentials();
    }

    // 4./5. Correct password from here on.
    await this.limiter.reset(keys.emailIp);
    const outcome = await this.openSession(account, input.password, client);
    if (outcome.kind !== 'created') {
      await this.securityLog.record({
        type: 'LOGIN_FAILED',
        userId: account.id,
        ...clientFields(client),
        metadata: { cause: outcome.kind },
      });
      throw outcome.kind === 'banned' ? new AccountBanned() : new AppAccessDenied();
    }

    const issued = await this.accessTokens.issue({
      userId: account.id,
      sessionId: outcome.sessionId,
      app: client.app,
      roles: outcome.roles,
    });
    return {
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt,
      refreshToken: outcome.refreshToken,
      refreshTokenExpiresAt: outcome.refreshExpiresAt,
      sessionId: outcome.sessionId,
      user: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        emailVerified: account.emailVerifiedAt !== null,
        roles: outcome.roles,
      },
    };
  }

  private async openSession(
    account: AccountRecord,
    password: string,
    client: ClientContext,
  ): Promise<SessionOutcome> {
    // Cheap pre-check outside the transaction (the common "banned" case creates nothing).
    if (account.banned) return { kind: 'banned' };

    const lifetime = sessionLifetime(client.app);
    const refresh = this.refreshTokens.generate();
    const rehash = this.hasher.needsRehash(account.passwordHash)
      ? await this.hasher.rehashVerified(password)
      : null;

    return this.tx.run(async (trx): Promise<SessionOutcome> => {
      // Serialise with ban / role changes on this user (see the class comment).
      if (!(await this.accounts.lockUserShared(trx, account.id))) {
        return { kind: 'banned' }; // account vanished: never happens (no deletes)
      }
      if ((await this.bans.findActive(account.id, trx)) !== null) return { kind: 'banned' };
      const roles = await this.access.getRoles(account.id, trx);
      if (!this.access.canLoginToApp(roles, client.app)) {
        return { kind: 'app_access_denied' };
      }

      const session = await this.sessions.createSession(trx, {
        userId: account.id,
        app: client.app,
        ip: client.ip,
        userAgent: client.userAgent === '' ? null : client.userAgent,
        absoluteTtlSeconds: lifetime.absoluteTtlSeconds,
      });
      const token = await this.sessions.insertRefreshToken(trx, {
        sessionId: session.id,
        tokenHash: refresh.hash,
        parentId: null,
        idleTtlSeconds: lifetime.idleTtlSeconds,
      });
      if (rehash !== null) {
        await this.accounts.replacePasswordHash(trx, account.id, rehash);
        this.logger.log(
          { userId: account.id },
          'Password rehashed with the current Argon2 parameters',
        );
      }
      await this.securityLog.record(
        {
          type: 'LOGIN_SUCCEEDED',
          userId: account.id,
          sessionId: session.id,
          ...clientFields(client),
        },
        trx,
      );
      return {
        kind: 'created',
        sessionId: session.id,
        refreshToken: refresh.token,
        refreshExpiresAt: token.expiresAt,
        roles,
      };
    });
  }

  private async throttled(
    client: ClientContext,
    emailHash: Buffer,
    limiter: 'ip' | 'email_ip' | 'email',
    result: RateLimitResult,
  ): Promise<never> {
    await this.securityLog.record({
      type: 'LOGIN_THROTTLED',
      emailHash,
      ...clientFields(client),
      metadata: { limiter },
    });
    throw new TooManyAttempts(result.ttlMs);
  }
}
