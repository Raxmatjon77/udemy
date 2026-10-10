import { createHash, createHmac, generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
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
import { ChangePasswordCommand } from './application/use-cases/change-password.command';
import { LoginCommand } from './application/use-cases/login.command';
import { RegisterUserCommand } from './application/use-cases/register-user.command';
import { RequestEmailVerificationCommand } from './application/use-cases/request-email-verification.command';
import { RequestPasswordResetCommand } from './application/use-cases/request-password-reset.command';
import { ResetPasswordCommand } from './application/use-cases/reset-password.command';
import { VerifyEmailCommand } from './application/use-cases/verify-email.command';
import {
  EmailAlreadyVerified,
  InvalidCredentials,
  InvalidOneTimeToken,
} from './domain/identity.errors';
import { IdentityModule } from './index';

/**
 * T9 email flows with the real adapters (Kysely, Redis, outbox, Argon2) against the
 * integration Postgres + Redis.
 *
 * The api never creates raw tokens (D10): the worker does. The worker's IssueOneTimeToken
 * cannot be imported here (apps do not import each other), so `issueLikeWorker` re-states its
 * contract in a few lines: raw = base64url(HMAC-SHA256(secret, eventId ‖ purpose)), stored as
 * sha256(raw) with expires_at = requested_at + TTL. The worker's own integration test covers
 * the real issuer + Mailpit, and the e2e run against both processes covers the whole chain.
 */
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';
const WORKER_SECRET = 'it-email-token-secret-0123456789abcdef0123';

describe('identity email flows (integration, real Postgres + Redis)', () => {
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
    keysDir = await mkdtemp(join(tmpdir(), 'udemy-identity-email-it-'));
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

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  function client(app: ClientContext['app'] = 'student'): ClientContext {
    return {
      clientId: `${app}-bff`,
      app,
      ip: `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
      userAgent: 'vitest email-flows integration',
    };
  }

  async function signUp(): Promise<{ id: string; email: string }> {
    const email = `it-email-${randomUUID()}@example.test`;
    await get(RegisterUserCommand).execute({
      email,
      password: PASSWORD,
      displayName: 'Email Flows',
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

  const login = (email: string, password = PASSWORD) =>
    get(LoginCommand).execute({ email, password, client: client() });

  /** The newest outbox event of that type for the user (what Debezium ships to the worker). */
  async function outboxEvent(
    userId: string,
    type: string,
  ): Promise<{ id: string; payload: Record<string, unknown> }> {
    const row = await pg.db
      .selectFrom('outbox.events')
      .select(['id', 'payload'])
      .where('aggregateId', '=', userId)
      .where('type', '=', type)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    return { id: row.id, payload: row.payload as Record<string, unknown> };
  }

  /** The worker's IssueOneTimeToken, reduced to its storage contract (see the file comment). */
  async function issueLikeWorker(
    event: { id: string; payload: Record<string, unknown> },
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): Promise<string> {
    const raw = createHmac('sha256', WORKER_SECRET)
      .update(event.id)
      .update(purpose)
      .digest('base64url');
    const requestedAt = new Date(String(event.payload.requestedAt));
    const ttlMs = purpose === 'PASSWORD_RESET' ? 30 * 60_000 : 24 * 60 * 60_000;
    const userId = String(event.payload.userId);
    await pg.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity.oneTimeTokens')
        .set({ invalidatedAt: sql<Date>`now()` })
        .where('userId', '=', userId)
        .where('purpose', '=', purpose)
        .where('consumedAt', 'is', null)
        .where('invalidatedAt', 'is', null)
        .where('sourceEventId', '<>', event.id)
        .execute();
      await trx
        .insertInto('identity.oneTimeTokens')
        .values({
          userId,
          purpose,
          tokenHash: createHash('sha256').update(raw).digest(),
          email: String(event.payload.email),
          sourceEventId: event.id,
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + ttlMs),
        })
        .onConflict((oc) => oc.column('sourceEventId').doNothing())
        .execute();
    });
    return raw;
  }

  const userRow = (id: string) =>
    pg.db
      .selectFrom('identity.users')
      .select(['emailVerifiedAt', 'passwordChangedAt'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const principal = (userId: string, sessionId: string): Principal => ({
    userId,
    sessionId,
    app: 'student',
    roles: ['STUDENT'],
    permissions: new Set(),
    tokenId: randomUUID(),
  });

  const sidKeySet = async (sessionId: string): Promise<boolean> =>
    (await itRedis.redis.exists(`auth:revoked:sid:${sessionId}`)) === 1;

  it('signup -> EmailVerificationRequested -> token -> verify (idempotent) -> emailVerified at login', async (ctx) => {
    skip(ctx);
    const user = await signUp();
    const event = await outboxEvent(user.id, 'EmailVerificationRequested.v1');
    expect(event.payload).toMatchObject({ userId: user.id, email: user.email, reason: 'SIGNUP' });
    const token = await issueLikeWorker(event, 'EMAIL_VERIFICATION');

    await get(VerifyEmailCommand).execute({ token });
    expect((await userRow(user.id)).emailVerifiedAt).toBeInstanceOf(Date);
    await expect(get(VerifyEmailCommand).execute({ token })).resolves.toBeUndefined();
    expect((await outboxEvent(user.id, 'EmailVerified.v1')).payload).toMatchObject({
      userId: user.id,
      email: user.email,
    });
    expect((await login(user.email)).user.emailVerified).toBe(true);

    await expect(get(VerifyEmailCommand).execute({ token: `${token}x` })).rejects.toBeInstanceOf(
      InvalidOneTimeToken,
    );
    const session = await login(user.email);
    await expect(
      get(RequestEmailVerificationCommand).execute(principal(user.id, session.sessionId)),
    ).rejects.toBeInstanceOf(EmailAlreadyVerified);
  });

  it('resend supersedes the signup link', async (ctx) => {
    skip(ctx);
    const user = await signUp();
    const signupToken = await issueLikeWorker(
      await outboxEvent(user.id, 'EmailVerificationRequested.v1'),
      'EMAIL_VERIFICATION',
    );
    const session = await login(user.email);
    await get(RequestEmailVerificationCommand).execute(principal(user.id, session.sessionId));
    const resend = await outboxEvent(user.id, 'EmailVerificationRequested.v1');
    expect(resend.payload).toMatchObject({ reason: 'RESEND' });
    const resendToken = await issueLikeWorker(resend, 'EMAIL_VERIFICATION');

    await expect(get(VerifyEmailCommand).execute({ token: signupToken })).rejects.toBeInstanceOf(
      InvalidOneTimeToken,
    );
    await get(VerifyEmailCommand).execute({ token: resendToken });
    expect((await userRow(user.id)).emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('forgot -> token -> reset: new password, email verified, ALL sessions revoked (DB + Redis)', async (ctx) => {
    skip(ctx);
    const user = await signUp();
    const a = await login(user.email);
    const b = await login(user.email);

    const started = performance.now();
    await expect(
      get(RequestPasswordResetCommand).execute({ email: user.email, client: client() }),
    ).resolves.toBe('requested');
    expect(performance.now() - started).toBeGreaterThanOrEqual(395);
    const token = await issueLikeWorker(
      await outboxEvent(user.id, 'PasswordResetRequested.v1'),
      'PASSWORD_RESET',
    );

    await get(ResetPasswordCommand).execute({ token, newPassword: NEW_PASSWORD, client: client() });

    const sessions = await pg.db
      .selectFrom('identity.sessions')
      .select(['id', 'revokeReason'])
      .where('userId', '=', user.id)
      .execute();
    expect(sessions.map((s) => s.revokeReason)).toEqual(['PASSWORD_RESET', 'PASSWORD_RESET']);
    expect(await sidKeySet(a.sessionId)).toBe(true);
    expect(await sidKeySet(b.sessionId)).toBe(true);
    expect((await userRow(user.id)).emailVerifiedAt).toBeInstanceOf(Date);
    expect((await outboxEvent(user.id, 'PasswordChanged.v1')).payload).toMatchObject({
      via: 'RESET',
    });
    await expect(login(user.email)).rejects.toBeInstanceOf(InvalidCredentials);
    await expect(login(user.email, NEW_PASSWORD)).resolves.toMatchObject({
      user: { emailVerified: true },
    });
    await expect(
      get(ResetPasswordCommand).execute({
        token,
        newPassword: 'third passphrase here',
        client: client(),
      }),
    ).rejects.toBeInstanceOf(InvalidOneTimeToken);
  });

  it('forgot for an unknown email still takes the 400 ms floor and writes nothing', async (ctx) => {
    skip(ctx);
    const started = performance.now();
    await expect(
      get(RequestPasswordResetCommand).execute({
        email: `nobody-${randomUUID()}@example.test`,
        client: client(),
      }),
    ).resolves.toBe('unknown_email');
    expect(performance.now() - started).toBeGreaterThanOrEqual(395);
  });

  it('change password: keeps the calling session, revokes the others, kills live reset links', async (ctx) => {
    skip(ctx);
    const user = await signUp();
    const current = await login(user.email);
    const other = await login(user.email);
    await get(RequestPasswordResetCommand).execute({ email: user.email, client: client() });
    const resetToken = await issueLikeWorker(
      await outboxEvent(user.id, 'PasswordResetRequested.v1'),
      'PASSWORD_RESET',
    );

    await expect(
      get(ChangePasswordCommand).execute({
        principal: principal(user.id, current.sessionId),
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        client: client(),
      }),
    ).resolves.toEqual({ revokedCount: 1 });

    const sessions = await pg.db
      .selectFrom('identity.sessions')
      .select(['id', 'revokeReason'])
      .where('userId', '=', user.id)
      .execute();
    expect(sessions.find((s) => s.id === current.sessionId)?.revokeReason).toBeNull();
    expect(sessions.find((s) => s.id === other.sessionId)?.revokeReason).toBe('PASSWORD_CHANGED');
    expect(await sidKeySet(other.sessionId)).toBe(true);
    expect(await sidKeySet(current.sessionId)).toBe(false);
    await expect(
      get(ResetPasswordCommand).execute({
        token: resetToken,
        newPassword: 'x'.repeat(20),
        client: client(),
      }),
    ).rejects.toBeInstanceOf(InvalidOneTimeToken);
  });
});
