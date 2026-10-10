import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../../../shared/auth';
import { clientFields } from '../client-fields';
import { SecurityEventLog } from '../ports/security-event.log';
import { SessionRepository } from '../ports/session.repository';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface LogoutAllSessionsInput {
  readonly principal: Principal;
  readonly client: ClientContext;
}

/**
 * `LogoutAllSessions` (design §5): revokes every active session of the user in every app,
 * including the calling one (`LOGOUT_ALL`), and sets one Redis sid key per session before the
 * commit, so all access tokens stop working at once.
 */
@Injectable()
export class LogoutAllSessionsCommand {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly revocations: SessionRevocationStore,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: LogoutAllSessionsInput): Promise<{ revokedCount: number }> {
    const { principal } = input;
    return this.tx.run(async (trx) => {
      const revoked = await this.sessions.revokeAllForUser(trx, principal.userId, 'LOGOUT_ALL');
      await this.securityLog.record(
        {
          type: 'LOGOUT_ALL',
          userId: principal.userId,
          sessionId: principal.sessionId,
          ...clientFields(input.client),
          metadata: { revokedCount: revoked.length },
        },
        trx,
      );
      // The caller's own sid too, even if its session had already ended in the DB.
      await this.revocations.revokeMany([...revoked, principal.sessionId]);
      return { revokedCount: revoked.length };
    });
  }
}
