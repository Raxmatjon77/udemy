import { Injectable } from '@nestjs/common';
import type { ClientApp } from '@udemy/contracts';
import type { Principal } from '../../../../shared/auth';
import { describeDevice } from '../../domain/device';
import { SessionRepository } from '../ports/session.repository';

/** One row of `GET /auth/sessions` (contracts `SessionView`, dates not yet serialised). */
export interface SessionView {
  readonly id: string;
  readonly app: ClientApp;
  /** Parsed from the stored User-Agent at read time; null when unknown. */
  readonly device: string | null;
  /** Last known client IP. */
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  /** The session that made this request. */
  readonly current: boolean;
}

/**
 * `ListMySessions` (design §5): the caller's active sessions in every app (not revoked, not
 * absolutely expired, current refresh token not expired), most recently used first.
 */
@Injectable()
export class ListMySessionsQuery {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(principal: Principal): Promise<SessionView[]> {
    const rows = await this.sessions.listActive(principal.userId);
    return rows
      .map((row) => ({
        id: row.id,
        app: row.app,
        device: describeDevice(row.userAgent),
        ip: row.lastIp,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        current: row.id === principal.sessionId,
      }))
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime() || b.id.localeCompare(a.id));
  }
}
