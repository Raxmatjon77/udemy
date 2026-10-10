import { Injectable } from '@nestjs/common';
import { type Executor, sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { type SecurityEvent, SecurityEventLog } from '../../application/ports/security-event.log';
import { toInetOrNull } from './inet';

const MAX_USER_AGENT_LENGTH = 512;

/** Inserts into the append-only `identity.security_events` (occurred_at = SQL now()). */
@Injectable()
export class KyselySecurityEventLog extends SecurityEventLog {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async record(event: SecurityEvent, ex: Executor = this.db): Promise<void> {
    const userAgent =
      event.userAgent === null || event.userAgent === undefined || event.userAgent === ''
        ? null
        : event.userAgent.slice(0, MAX_USER_AGENT_LENGTH);
    await ex
      .insertInto('identity.securityEvents')
      .values({
        type: event.type,
        userId: event.userId ?? null,
        sessionId: event.sessionId ?? null,
        clientApp: event.clientApp ?? null,
        ip: toInetOrNull(event.ip),
        userAgent,
        emailHash: event.emailHash ?? null,
        metadata: JSON.stringify(event.metadata ?? {}),
        occurredAt: sql<Date>`now()`,
      })
      .execute();
  }
}
