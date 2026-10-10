import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../../../shared/auth';
import { SessionNotFound } from '../../domain/identity.errors';
import { clientFields } from '../client-fields';
import { SecurityEventLog } from '../ports/security-event.log';
import { SessionRepository } from '../ports/session.repository';
import { SessionRevocationStore } from '../ports/session-revocation.store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface RevokeSessionInput {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly client: ClientContext;
}

/**
 * `RevokeSession` (design §5): ends one of the caller's own sessions (`USER_REVOKED`), in any
 * app. Another user's session, an unknown id and an already-revoked session are all 404
 * `session_not_found`, so session ids cannot be probed.
 */
@Injectable()
export class RevokeSessionCommand {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly securityLog: SecurityEventLog,
    private readonly revocations: SessionRevocationStore,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: RevokeSessionInput): Promise<void> {
    const { principal, sessionId } = input;
    await this.tx.run(async (trx) => {
      const revoked = await this.sessions.revokeOwnSession(
        trx,
        principal.userId,
        sessionId,
        'USER_REVOKED',
      );
      if (!revoked) throw new SessionNotFound();
      await this.securityLog.record(
        {
          type: 'SESSION_REVOKED',
          userId: principal.userId,
          sessionId,
          ...clientFields(input.client),
          metadata: { bySessionId: principal.sessionId },
        },
        trx,
      );
      await this.revocations.revoke(sessionId);
    });
  }
}
