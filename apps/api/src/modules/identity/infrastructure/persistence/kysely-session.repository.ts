import { Injectable } from '@nestjs/common';
import { ClientAppSchema, type ClientApp } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type ActiveSessionRow,
  type ChildToken,
  type CreatedSession,
  type LockedRefreshToken,
  type LockedSession,
  type NewRefreshToken,
  type NewSession,
  SessionRepository,
  type TokenOwner,
} from '../../application/ports/session.repository';
import type { SessionRevokeReason } from '../../domain/session';
import { mapIdentityConstraints } from './identity-constraint-errors';
import { toInet } from './inet';

const MAX_USER_AGENT_LENGTH = 512;

/** The CHECK constraint guarantees the value; parse anyway so a bad row fails loudly. */
function clientApp(value: string): ClientApp {
  return ClientAppSchema.parse(value);
}

function secondsInterval(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError(`TTL must be a positive whole number of seconds, got ${seconds}`);
  }
  return sql<string>`make_interval(secs => ${seconds}::int)`;
}

@Injectable()
export class KyselySessionRepository extends SessionRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async createSession(trx: Transaction<DB>, session: NewSession): Promise<CreatedSession> {
    const ip = toInet(session.ip);
    const userAgent =
      session.userAgent === null || session.userAgent === ''
        ? null
        : session.userAgent.slice(0, MAX_USER_AGENT_LENGTH);
    return mapIdentityConstraints(() =>
      trx
        .insertInto('identity.sessions')
        .values({
          userId: session.userId,
          clientApp: session.app,
          userAgent,
          createdIp: ip,
          lastIp: ip,
          createdAt: sql<Date>`now()`,
          lastUsedAt: sql<Date>`now()`,
          absoluteExpiresAt: sql<Date>`now() + ${secondsInterval(session.absoluteTtlSeconds)}`,
        })
        .returning(['id', 'absoluteExpiresAt'])
        .executeTakeFirstOrThrow(),
    );
  }

  async insertRefreshToken(
    trx: Transaction<DB>,
    token: NewRefreshToken,
  ): Promise<{ id: string; expiresAt: Date }> {
    return mapIdentityConstraints(() =>
      trx
        .insertInto('identity.refreshTokens')
        .values({
          sessionId: token.sessionId,
          tokenHash: token.tokenHash,
          parentId: token.parentId,
          issuedAt: sql<Date>`now()`,
          // min(issuedAt + idleTtl(app), absoluteExpiresAt) (design §4 Session invariant)
          expiresAt: sql<Date>`least(now() + ${secondsInterval(token.idleTtlSeconds)}, (
            select s.absolute_expires_at from identity.sessions s where s.id = ${token.sessionId}
          ))`,
        })
        .returning(['id', 'expiresAt'])
        .executeTakeFirstOrThrow(),
    );
  }

  async lockTokenByHash(
    trx: Transaction<DB>,
    tokenHash: Buffer,
  ): Promise<LockedRefreshToken | null> {
    const row = await trx
      .selectFrom('identity.refreshTokens')
      .select(['id', 'sessionId', 'expiresAt', 'consumedAt', sql<Date>`now()`.as('now')])
      .where('tokenHash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  async lockSession(trx: Transaction<DB>, sessionId: string): Promise<LockedSession | null> {
    const row = await trx
      .selectFrom('identity.sessions')
      .select(['id', 'userId', 'clientApp', 'absoluteExpiresAt', 'revokedAt'])
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : { ...row, clientApp: clientApp(row.clientApp) };
  }

  async findChild(trx: Transaction<DB>, tokenId: string): Promise<ChildToken | null> {
    const row = await trx
      .selectFrom('identity.refreshTokens')
      .select(['id', 'consumedAt', 'expiresAt'])
      .where('parentId', '=', tokenId)
      .executeTakeFirst();
    return row ?? null;
  }

  async consumeToken(trx: Transaction<DB>, tokenId: string): Promise<void> {
    await trx
      .updateTable('identity.refreshTokens')
      .set({ consumedAt: sql<Date>`now()` })
      .where('id', '=', tokenId)
      .where('consumedAt', 'is', null)
      .execute();
  }

  async touchSession(trx: Transaction<DB>, sessionId: string, ip: string): Promise<void> {
    await trx
      .updateTable('identity.sessions')
      .set({ lastUsedAt: sql<Date>`now()`, lastIp: toInet(ip) })
      .where('id', '=', sessionId)
      .execute();
  }

  async revokeSession(
    trx: Transaction<DB>,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const rows = await trx
      .updateTable('identity.sessions')
      .set({ revokedAt: sql<Date>`now()`, revokeReason: reason })
      .where('id', '=', sessionId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async revokeOwnSession(
    trx: Transaction<DB>,
    userId: string,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const rows = await trx
      .updateTable('identity.sessions')
      .set({ revokedAt: sql<Date>`now()`, revokeReason: reason })
      .where('id', '=', sessionId)
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async revokeAllForUser(
    trx: Transaction<DB>,
    userId: string,
    reason: SessionRevokeReason,
  ): Promise<string[]> {
    const rows = await trx
      .updateTable('identity.sessions')
      .set({ revokedAt: sql<Date>`now()`, revokeReason: reason })
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();
    return rows.map((r) => r.id);
  }

  async findTokenOwner(ex: Executor, tokenHash: Buffer): Promise<TokenOwner | null> {
    const row = await ex
      .selectFrom('identity.refreshTokens as rt')
      .innerJoin('identity.sessions as s', 's.id', 'rt.sessionId')
      .select(['s.id as sessionId', 's.userId', 's.clientApp'])
      .where('rt.tokenHash', '=', tokenHash)
      .executeTakeFirst();
    return row === undefined ? null : { ...row, clientApp: clientApp(row.clientApp) };
  }

  /** Schema doc §6 "Sessions list": answered index-only from refresh_tokens_session_id_current_uq. */
  private activeSessions(ex: Executor, userId: string) {
    return ex
      .selectFrom('identity.sessions as s')
      .innerJoin('identity.refreshTokens as rt', (join) =>
        join.onRef('rt.sessionId', '=', 's.id').on('rt.consumedAt', 'is', null),
      )
      .where('s.userId', '=', userId)
      .where('s.revokedAt', 'is', null)
      .where('s.absoluteExpiresAt', '>', sql<Date>`now()`)
      .where('rt.expiresAt', '>', sql<Date>`now()`);
  }

  async listActive(userId: string, ex: Executor = this.db): Promise<ActiveSessionRow[]> {
    const rows = await this.activeSessions(ex, userId)
      .select(['s.id', 's.clientApp', 's.userAgent', 's.lastIp', 's.createdAt', 's.lastUsedAt'])
      .execute();
    return rows.map((row) => ({
      id: row.id,
      app: clientApp(row.clientApp),
      userAgent: row.userAgent,
      lastIp: row.lastIp,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  async countActive(userId: string, ex: Executor = this.db): Promise<number> {
    const row = await this.activeSessions(ex, userId)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
