import { Injectable, Logger } from '@nestjs/common';
import type { ClientContext } from '../../../../shared/auth';
import { clientFields } from '../client-fields';
import { RefreshTokenCodec } from '../ports/refresh-token.codec';
import { SecurityEventLog } from '../ports/security-event.log';
import { SessionRepository } from '../ports/session.repository';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface LogoutInput {
  readonly refreshToken: string;
  readonly client: ClientContext;
}

/**
 * `Logout` (design §5): revokes the session (refresh-token family) the presented token belongs
 * to, current or already rotated. Idempotent and silent: unknown tokens, tokens of another
 * app's session and already-revoked sessions all succeed without doing anything. Locks only
 * the session row (schema doc §6). The Redis sid key is set before commit (fail closed).
 */
@Injectable()
export class LogoutCommand {
  private readonly logger = new Logger(LogoutCommand.name);

  constructor(
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly revocations: SessionRevocationStore,
    private readonly refreshTokens: RefreshTokenCodec,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: LogoutInput): Promise<void> {
    const tokenHash = this.refreshTokens.hash(input.refreshToken);
    await this.tx.run(async (trx) => {
      const owner = await this.sessions.findTokenOwner(trx, tokenHash);
      if (owner === null) return;
      if (owner.clientApp !== input.client.app) {
        // App confinement: a BFF only manages its own sessions.
        this.logger.warn(
          { sessionId: owner.sessionId, sessionApp: owner.clientApp, clientApp: input.client.app },
          'Logout with a refresh token of another app ignored',
        );
        return;
      }
      if (!(await this.sessions.revokeSession(trx, owner.sessionId, 'LOGOUT'))) return;
      await this.securityLog.record(
        {
          type: 'LOGOUT',
          userId: owner.userId,
          sessionId: owner.sessionId,
          ...clientFields(input.client),
        },
        trx,
      );
      await this.revocations.revoke(owner.sessionId);
    });
  }
}
