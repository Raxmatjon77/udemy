import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from '@udemy/db';
import { createConfigModule, DATABASE } from '@udemy/nest-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSupportModule, type ClientContext, type Principal } from '../../shared/auth';
import { apiEnvSchema, AppConfigModule } from '../../shared/config';
import { OutboxModule } from '../../shared/outbox';
import { RateLimiter, REDIS } from '../../shared/redis';
import {
  deleteTestUsers,
  useIntegrationDatabase,
  useIntegrationRedis,
} from '../../testing/integration';
import { TEST_ENV } from '../../testing/test-env';
import { AccessFacade } from '../access';
import { LoginCommand } from './application/use-cases/login.command';
import { LogoutAllSessionsCommand } from './application/use-cases/logout-all-sessions.command';
import { RefreshSessionCommand } from './application/use-cases/refresh-session.command';
import { RegisterUserCommand } from './application/use-cases/register-user.command';
import { AccountBanned, InvalidRefreshToken } from './domain/identity.errors';
import { IdentityFacade, IdentityModule } from './index';

/**
 * The session use cases with their real adapters (Kysely, Redis, outbox, Argon2) against the
 * integration Postgres + Redis (IT_DATABASE_URL / IT_REDIS_URL, src/testing/integration.ts).
 * Every test uses fresh emails and client IPs, so Redis rate-limit counters never collide;
 * afterAll removes the users and everything written for them.
 */
const PASSWORD = 'correct horse battery';

describe('identity sessions (integration, real Postgres + Redis)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const itRedis = useIntegrationRedis();
  const createdUsers: string[] = [];
  const savedEnv = { ...process.env };
  let keysDir: string | undefined;
  let moduleRef: TestingModule | undefined;

  const get = <T>(type: abstract new (...args: never[]) => T): T => {
    if (moduleRef === undefined) throw new Error('module not compiled');
    return moduleRef.get(type as never, { strict: false });
  };

  beforeAll(async () => {
    if (!pg.available || !itRedis.available) return;
    keysDir = await mkdtemp(join(tmpdir(), 'udemy-identity-it-'));
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    await writeFile(join(keysDir, `${TEST_ENV.JWT_ACTIVE_KID}.pem`), pem, { mode: 0o600 });
    Object.assign(process.env, TEST_ENV, { JWT_KEYS_DIR: keysDir, LOG_LEVEL: 'silent' });

    @Global()
    @Module({
      providers: [
        { provide: DATABASE, useValue: pg.db },
        { provide: REDIS, useValue: itRedis.redis },
        RateLimiter,
      ],
      exports: [DATABASE, REDIS, RateLimiter],
    })
    class RealInfrastructureModule {}

    moduleRef = await Test.createTestingModule({
      imports: [
        await createConfigModule(apiEnvSchema),
        AppConfigModule,
        AuthSupportModule,
        OutboxModule,
        RealInfrastructureModule,
        IdentityModule,
      ],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    if (pg.available) await deleteTestUsers(pg.db, createdUsers);
    await moduleRef?.close();
    if (keysDir !== undefined) await rm(keysDir, { recursive: true, force: true });
    process.env = savedEnv;
  });

  /** A fresh documentation-range IP, so rate-limit keys never collide across tests/runs. */
  function client(app: ClientContext['app'] = 'student'): ClientContext {
    return {
      clientId: `${app}-bff`,
      app,
      ip: `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
      userAgent: 'vitest integration',
    };
  }

  async function newUser(): Promise<{ id: string; email: string }> {
    const email = `it-${randomUUID()}@example.test`;
    await get(RegisterUserCommand).execute({
      email,
      password: PASSWORD,
      displayName: 'Integration User',
      client: client(),
    });
    const row = await pg.db
      .selectFrom('identity.users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    createdUsers.push(row.id);
    return { id: row.id, email };
  }

  const login = (email: string, c: ClientContext = client()) =>
    get(LoginCommand).execute({ email, password: PASSWORD, client: c });

  const sessionRow = (id: string) =>
    pg.db
      .selectFrom('identity.sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const tokensOf = (sessionId: string) =>
    pg.db
      .selectFrom('identity.refreshTokens')
      .selectAll()
      .where('sessionId', '=', sessionId)
      .orderBy('issuedAt')
      .orderBy('id')
      .execute();

  const sidKeySet = async (sessionId: string): Promise<boolean> =>
    (await itRedis.redis.exists(`auth:revoked:sid:${sessionId}`)) === 1;

  const securityEvents = (userId: string) =>
    pg.db
      .selectFrom('identity.securityEvents')
      .select(['type', 'sessionId', 'metadata'])
      .where('userId', '=', userId)
      .orderBy('occurredAt')
      .orderBy('id')
      .execute();

  const outboxTypes = async (userId: string): Promise<string[]> =>
    (
      await pg.db
        .selectFrom('outbox.events')
        .select('type')
        .where('aggregateId', '=', userId)
        .orderBy('createdAt')
        .orderBy('id')
        .execute()
    ).map((r) => r.type);

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  it('signup writes the account with UserRegistered + EmailVerificationRequested; an existing email notices once', async (ctx) => {
    skip(ctx);
    const user = await newUser();
    expect(await outboxTypes(user.id)).toEqual([
      'UserRegistered.v1',
      'EmailVerificationRequested.v1',
    ]);

    for (let i = 0; i < 2; i += 1) {
      await get(RegisterUserCommand).execute({
        email: user.email.toUpperCase(),
        password: 'another strong passphrase',
        displayName: 'Someone Else',
        client: client(),
      });
    }
    expect(await outboxTypes(user.id)).toEqual([
      'UserRegistered.v1',
      'EmailVerificationRequested.v1',
      'SignupAttemptedForExistingEmail.v1',
    ]);
  });

  it('concurrent refreshes with the same token: exactly one rotation, the others take the grace path', async (ctx) => {
    skip(ctx);
    const user = await newUser();
    const c = client();
    const { refreshToken, sessionId } = await login(user.email, c);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        get(RefreshSessionCommand).execute({ refreshToken, client: c }),
      ),
    );

    const rotated = results.filter((r) => r.refreshToken !== undefined);
    expect(rotated).toHaveLength(1);
    expect(results.every((r) => r.accessToken.length > 0)).toBe(true);
    const tokens = await tokensOf(sessionId);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.consumedAt).not.toBeNull();
    expect(tokens[1]).toMatchObject({ parentId: tokens[0]?.id, consumedAt: null });
    expect((await sessionRow(sessionId)).revokedAt).toBeNull();
    expect(await sidKeySet(sessionId)).toBe(false);
  });

  it('reuse after the grace window revokes the family, sets the sid key and emits SessionCompromiseDetected', async (ctx) => {
    skip(ctx);
    const user = await newUser();
    const c = client();
    const { refreshToken, sessionId } = await login(user.email, c);
    const second = await get(RefreshSessionCommand).execute({ refreshToken, client: c });
    // Age the rotation past the 10 s grace window (consumed_at is not append-only).
    await sql`update identity.refresh_tokens set consumed_at = consumed_at - interval '11 seconds'
              where session_id = ${sessionId} and consumed_at is not null`.execute(pg.db);

    await expect(
      get(RefreshSessionCommand).execute({ refreshToken, client: c }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);

    expect(await sessionRow(sessionId)).toMatchObject({ revokeReason: 'REUSE_DETECTED' });
    expect(await sidKeySet(sessionId)).toBe(true);
    expect(await outboxTypes(user.id)).toContain('SessionCompromiseDetected.v1');
    expect((await securityEvents(user.id)).map((e) => e.type)).toContain('REFRESH_REUSE_DETECTED');
    // The rotated child is dead too.
    await expect(
      get(RefreshSessionCommand).execute({ refreshToken: second.refreshToken ?? '', client: c }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect((await securityEvents(user.id)).at(-1)).toMatchObject({
      type: 'REFRESH_REJECTED',
      metadata: { cause: 'session_revoked' },
    });
  });

  it('logout-all revokes every session, sets every sid key, and their refresh tokens die', async (ctx) => {
    skip(ctx);
    const user = await newUser();
    const a = await login(user.email);
    const b = await login(user.email);
    const principal: Principal = {
      userId: user.id,
      sessionId: a.sessionId,
      app: 'student',
      roles: ['STUDENT'],
      permissions: new Set(),
      tokenId: randomUUID(),
    };

    await expect(
      get(LogoutAllSessionsCommand).execute({ principal, client: client() }),
    ).resolves.toEqual({ revokedCount: 2 });

    for (const s of [a, b]) {
      expect(await sessionRow(s.sessionId)).toMatchObject({ revokeReason: 'LOGOUT_ALL' });
      expect(await sidKeySet(s.sessionId)).toBe(true);
      await expect(
        get(RefreshSessionCommand).execute({ refreshToken: s.refreshToken, client: client() }),
      ).rejects.toBeInstanceOf(InvalidRefreshToken);
    }
  });

  it('a ban written behind the API is enforced on refresh (session revoked BANNED, sid key set)', async (ctx) => {
    skip(ctx);
    const admin = await newUser();
    const user = await newUser();
    const c = client();
    const { refreshToken, sessionId } = await login(user.email, c);
    await pg.db
      .insertInto('identity.userBans')
      .values({ userId: user.id, bannedBy: admin.id, reason: 'Integration test ban' })
      .execute();

    await expect(
      get(RefreshSessionCommand).execute({ refreshToken, client: c }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(await sessionRow(sessionId)).toMatchObject({ revokeReason: 'BANNED' });
    expect(await sidKeySet(sessionId)).toBe(true);
    expect((await securityEvents(user.id)).at(-1)).toMatchObject({
      type: 'REFRESH_REJECTED',
      metadata: { cause: 'banned' },
    });
    await expect(login(user.email)).rejects.toBeInstanceOf(AccountBanned);
  });

  it('IdentityFacade.banUser revokes sessions and sets sid keys before the caller commits', async (ctx) => {
    skip(ctx);
    const admin = await newUser();
    const user = await newUser();
    const s = await login(user.email);

    const ban = await pg.db.transaction().execute((trx) =>
      get(IdentityFacade).banUser(trx, {
        userId: user.id,
        actorId: admin.id,
        reason: 'Integration facade ban',
      }),
    );

    expect(ban).toMatchObject({ userId: user.id, bannedBy: admin.id, liftedAt: null });
    expect(await sessionRow(s.sessionId)).toMatchObject({ revokeReason: 'BANNED' });
    expect(await sidKeySet(s.sessionId)).toBe(true);
    expect(await outboxTypes(user.id)).toContain('UserBanned.v1');
    expect(await get(IdentityFacade).getAccountStatus(user.id)).toMatchObject({ status: 'BANNED' });
  });

  it('losing the app role is enforced on refresh (ROLE_LOST)', async (ctx) => {
    skip(ctx);
    const admin = await newUser();
    const user = await newUser();
    const access = get(AccessFacade);
    await pg.db.transaction().execute((trx) =>
      access.grantRole(trx, {
        userId: user.id,
        role: 'INSTRUCTOR',
        actorId: admin.id,
        reason: 'integration test',
        source: { type: 'admin' },
      }),
    );
    const c = client('instructor');
    const { refreshToken, sessionId } = await login(user.email, c);
    await pg.db.transaction().execute((trx) =>
      access.revokeRole(trx, {
        userId: user.id,
        role: 'INSTRUCTOR',
        actorId: admin.id,
        reason: 'integration test',
      }),
    );

    await expect(
      get(RefreshSessionCommand).execute({ refreshToken, client: c }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(await sessionRow(sessionId)).toMatchObject({ revokeReason: 'ROLE_LOST' });
    expect(await sidKeySet(sessionId)).toBe(true);
  });

  it('searchUsers: escaped substring match, status filter, microsecond-safe keyset pages', async (ctx) => {
    skip(ctx);
    const marker = `zq${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const user = await newUser();
      await pg.db.transaction().execute((trx) =>
        get(IdentityFacade).changeDisplayName(trx, {
          userId: user.id,
          displayName: `${marker} 100%_${i}`,
        }),
      );
      ids.push(user.id);
    }
    const facade = get(IdentityFacade);

    const literal = await facade.searchUsers({ q: `${marker} 100%_1`, limit: 10 });
    expect(literal.items.map((u) => u.id)).toEqual([ids[1]]);
    // `_` / `%` are literals: "100x" must not match "100%".
    expect((await facade.searchUsers({ q: `${marker} 1_0`, limit: 10 })).items).toEqual([]);

    const page1 = await facade.searchUsers({ q: marker, limit: 2 });
    const page2 = await facade.searchUsers({ q: marker, limit: 2, cursor: page1.nextCursor ?? '' });
    expect([...page1.items, ...page2.items].map((u) => u.id)).toEqual([...ids].reverse());
    expect(page2.nextCursor).toBeNull();

    expect((await facade.searchUsers({ q: marker, status: 'BANNED', limit: 10 })).items).toEqual(
      [],
    );
    expect(
      (await facade.searchUsers({ q: marker, idIn: [ids[0] ?? ''], limit: 10 })).items.map(
        (u) => u.id,
      ),
    ).toEqual([ids[0]]);
    expect(await outboxTypes(ids[0] ?? '')).toContain('DisplayNameChanged.v1');
  });
});
