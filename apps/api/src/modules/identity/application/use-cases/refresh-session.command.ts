import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type { ClientContext } from '../../../../shared/auth';
import { AccessFacade } from '../../../access';
import { InvalidRefreshToken } from '../../domain/identity.errors';
import {
  decideRefresh,
  type RefreshRejectionCause,
  sessionLifetime,
  type SessionRevokeReason,
} from '../../domain/session';
import { clientFields } from '../client-fields';
import { AccessTokenIssuer } from '../ports/access-token-issuer';
import { IdentityEventPublisher } from '../ports/identity-event.publisher';
import { RefreshTokenCodec } from '../ports/refresh-token.codec';
import { SecurityEventLog } from '../ports/security-event.log';
import { type LockedSession, SessionRepository } from '../ports/session.repository';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { TransactionRunner } from '../ports/transaction-runner';
import { UserAccountRepository } from '../ports/user-account.repository';

export interface RefreshSessionInput {
  readonly refreshToken: string;
  readonly client: ClientContext;
}

/** `refreshToken*` are absent on the grace path: the BFF keeps its current refresh cookie. */
export interface RefreshSessionResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: Date;
}

/**
 * Thrown by the repository when the rotation insert hits `refresh_tokens_parent_id_uq` or
 * `refresh_tokens_session_id_current_uq` (schema doc §6): a concurrent rotation won. The
 * transaction is retried once and then takes the grace path.
 */
export class ConcurrentRotation extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('Concurrent refresh-token rotation', { cause: options.cause });
    this.name = 'ConcurrentRotation';
  }
}

type Outcome =
  | {
      readonly kind: 'rotated';
      readonly userId: string;
      readonly sessionId: string;
      readonly roles: Role[];
      readonly refreshToken: string;
      readonly refreshExpiresAt: Date;
    }
  | {
      readonly kind: 'grace';
      readonly userId: string;
      readonly sessionId: string;
      readonly roles: Role[];
    }
  | {
      readonly kind: 'rejected';
      readonly cause: RefreshRejectionCause;
      readonly userId: string | null;
      readonly sessionId: string | null;
    };

/** Causes that revoke the family before rejecting, and the revoke reason they record. */
const REVOKING_CAUSES: Partial<Record<RefreshRejectionCause, SessionRevokeReason>> = {
  reuse_detected: 'REUSE_DETECTED',
  banned: 'BANNED',
  role_lost: 'ROLE_LOST',
};

/**
 * `RefreshSession` (design §4 "Refresh algorithm", steps 1–7), in ONE transaction that locks
 * the token row and then the session row (`FOR UPDATE`, schema doc §6 lock order). A parallel
 * refresh with the same token waits on the token lock, then sees it consumed and takes the
 * 10 s grace path (access token only).
 *
 * Every failure is the single 401 `invalid_refresh_token`; the exact cause is logged and
 * written to `security_events` (REFRESH_REJECTED, or REFRESH_REUSE_DETECTED for reuse).
 * Revocations (reuse, ban, role lost) commit with their security event and outbox event, and
 * their Redis sid key is written BEFORE the commit: if Redis is down the transaction aborts
 * (503) rather than leaving live access tokens of a revoked session.
 */
@Injectable()
export class RefreshSessionCommand {
  private readonly logger = new Logger(RefreshSessionCommand.name);

  constructor(
    private readonly sessions: SessionRepository,
    private readonly accounts: UserAccountRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly events: IdentityEventPublisher,
    private readonly revocations: SessionRevocationStore,
    private readonly refreshTokens: RefreshTokenCodec,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly access: AccessFacade,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: RefreshSessionInput): Promise<RefreshSessionResult> {
    // 1. Hash the presented token (any string: garbage simply finds nothing).
    const tokenHash = this.refreshTokens.hash(input.refreshToken);
    const outcome = await this.runWithRetry(tokenHash, input.client);

    if (outcome.kind === 'rejected') {
      const log = { cause: outcome.cause, userId: outcome.userId, sessionId: outcome.sessionId };
      if (outcome.cause === 'reuse_detected') {
        this.logger.warn(log, 'Refresh token reuse detected; session revoked');
      } else {
        this.logger.log(log, 'Refresh rejected');
      }
      throw new InvalidRefreshToken();
    }

    // 7. Access token with the roles read in the transaction.
    const issued = await this.accessTokens.issue({
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      app: input.client.app,
      roles: outcome.roles,
    });
    if (outcome.kind === 'grace') {
      return { accessToken: issued.token, accessTokenExpiresAt: issued.expiresAt };
    }
    return {
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt,
      refreshToken: outcome.refreshToken,
      refreshTokenExpiresAt: outcome.refreshExpiresAt,
    };
  }

  private async runWithRetry(tokenHash: Buffer, client: ClientContext): Promise<Outcome> {
    try {
      return await this.tx.run((trx) => this.refreshInTransaction(trx, tokenHash, client));
    } catch (error) {
      if (!(error instanceof ConcurrentRotation)) throw error;
      this.logger.debug('Concurrent rotation; retrying the refresh once');
      return this.tx.run((trx) => this.refreshInTransaction(trx, tokenHash, client));
    }
  }

  private async refreshInTransaction(
    trx: Transaction<DB>,
    tokenHash: Buffer,
    client: ClientContext,
  ): Promise<Outcome> {
    // 1. Token row, locked. Unknown: nothing can be revoked (no family to attribute it to).
    const token = await this.sessions.lockTokenByHash(trx, tokenHash);
    if (token === null) return this.reject(trx, client, 'unknown_token', null);
    const session = await this.sessions.lockSession(trx, token.sessionId);
    if (session === null) return this.reject(trx, client, 'unknown_token', null);

    // 2.–4. Pure decision on the locked rows and the database clock.
    const child = token.consumedAt === null ? null : await this.sessions.findChild(trx, token.id);
    const decision = decideRefresh({
      token,
      session,
      child,
      clientApp: client.app,
      now: token.now,
    });
    if (decision.kind === 'reject') return this.reject(trx, client, decision.cause, session);
    if (decision.kind === 'reuse') return this.reject(trx, client, 'reuse_detected', session);

    // 5. Fresh account state: ban, then the role this app needs.
    const account = await this.accounts.findById(session.userId, trx);
    if (account === null) return this.reject(trx, client, 'account_missing', session);
    if (account.banned) return this.reject(trx, client, 'banned', session);
    const roles = await this.access.getRoles(session.userId, trx);
    if (!this.access.canLoginToApp(roles, client.app)) {
      return this.reject(trx, client, 'role_lost', session);
    }

    // 3. (grace) A parallel refresh already rotated this token: access token only.
    if (decision.kind === 'grace') {
      return { kind: 'grace', userId: session.userId, sessionId: session.id, roles };
    }

    // 6. Rotate: consume, insert the child, touch the session.
    const lifetime = sessionLifetime(session.clientApp);
    const next = this.refreshTokens.generate();
    await this.sessions.consumeToken(trx, token.id);
    const rotated = await this.sessions.insertRefreshToken(trx, {
      sessionId: session.id,
      tokenHash: next.hash,
      parentId: token.id,
      idleTtlSeconds: lifetime.idleTtlSeconds,
    });
    await this.sessions.touchSession(trx, session.id, client.ip);
    return {
      kind: 'rotated',
      userId: session.userId,
      sessionId: session.id,
      roles,
      refreshToken: next.token,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  /**
   * Records the rejection; for reuse / ban / role loss also revokes the family: DB revoke,
   * security event, (reuse) SessionCompromiseDetected, then the Redis sid key, all before the
   * caller's commit.
   */
  private async reject(
    trx: Transaction<DB>,
    client: ClientContext,
    cause: RefreshRejectionCause,
    session: LockedSession | null,
  ): Promise<Outcome> {
    const userId = session?.userId ?? null;
    const sessionId = session?.id ?? null;
    const revokeReason = REVOKING_CAUSES[cause];
    const revoked =
      session !== null && revokeReason !== undefined
        ? await this.sessions.revokeSession(trx, session.id, revokeReason)
        : false;

    await this.securityLog.record(
      {
        type: cause === 'reuse_detected' ? 'REFRESH_REUSE_DETECTED' : 'REFRESH_REJECTED',
        userId,
        sessionId,
        ...clientFields(client),
        metadata: { cause, ...(session === null ? {} : { sessionApp: session.clientApp }) },
      },
      trx,
    );

    if (revoked && session !== null) {
      if (cause === 'reuse_detected') {
        await this.events.sessionCompromiseDetected(trx, {
          userId: session.userId,
          sessionId: session.id,
          clientApp: session.clientApp,
          detectedAt: new Date().toISOString(),
        });
      }
      await this.revocations.revoke(session.id);
    }
    return { kind: 'rejected', cause, userId, sessionId };
  }
}
