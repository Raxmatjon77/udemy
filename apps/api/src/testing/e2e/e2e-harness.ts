// Must stay the first import: AppModule (imported below) validates process.env when it is imported.
import { E2E_APP_ENV } from './apply-e2e-app-env';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test as NestTest } from '@nestjs/testing';
import {
  type AuthResult,
  AuthResultSchema,
  type ClientApp,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemDetails,
  ProblemDetailsSchema,
} from '@udemy/contracts';
import { sql } from '@udemy/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { AppModule } from '../../app.module';
import { AccessFacade } from '../../modules/access';
import { BootstrapAdminCommand } from '../../modules/users';
import { deleteUsersTestData } from '../../modules/users/testing/users-test-data';
import { setupApp } from '../../setup-app';
import {
  type IntegrationDatabase,
  type IntegrationRedis,
  type SkippableContext,
  useIntegrationDatabase,
  useIntegrationRedis,
} from '../integration';
import { TEST_ENV } from '../test-env';
import { ipRateLimitKeys, TestNetIpAllocator } from './test-net-ips';

/*
 * Shared harness for HTTP e2e files that boot the REAL AppModule (all four global guards in
 * production order, `setupApp` prefix exclusions/versioning/Swagger, real Postgres + Redis).
 *
 * Usage (the env import MUST be the first import of the spec file):
 *
 *   import './testing/e2e/apply-e2e-app-env';
 *   import { useE2eApp } from './testing/e2e/e2e-harness';
 *   describe('...', () => {
 *     const e2e = useE2eApp();
 *     it('...', async (ctx) => { e2e.skip(ctx); ... });
 *   });
 *
 * Every test gets its own TEST-NET `X-Client-IP` (`e2e.ip()`), whose per-IP rate-limit keys
 * are cleared first, so neither earlier runs nor sibling tests can push it into a 429. The
 * file owns all its data: users (by tracked email/id), their applications, profiles, sessions,
 * outbox rows, security events, revocation keys and rate-limit keys are removed in afterAll.
 */

export const E2E_PASSWORD = 'correct horse battery staple';

/** The dev BFF secrets (apps/web-*\/.env.example); TEST_ENV holds their SHA-256. */
export const BFF_SECRETS = {
  student: 'dev-student-bff-secret-change-me-in-prod',
  instructor: 'dev-instructor-bff-secret-change-me-in-prod',
  admin: 'dev-admin-bff-secret-change-me-in-prod',
} as const satisfies Record<ClientApp, string>;

const E2E_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0 endpoints-e2e';

/** Stands in for the worker's EMAIL_TOKEN_SECRET (D10); the api only stores sha256(raw). */
const WORKER_EMAIL_TOKEN_SECRET = 'e2e-email-token-secret-0123456789abcdef0123';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
export type OneTimeTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface SignedUpUser {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

export interface BearerClient {
  call(method: HttpMethod, path: string): request.Test;
  get(path: string): request.Test;
  post(path: string): request.Test;
  patch(path: string): request.Test;
  delete(path: string): request.Test;
}

export interface E2eHarness {
  readonly pg: IntegrationDatabase;
  readonly redis: IntegrationRedis;
  readonly app: NestExpressApplication;
  /** A supertest agent on the running app. */
  http(): ReturnType<typeof request>;
  /** Skips the test locally when Postgres or Redis is unreachable (fails with CI=true). */
  skip(ctx: SkippableContext): void;
  /** This test's TEST-NET `X-Client-IP` (fresh per test; per-IP rate-limit keys cleared). */
  ip(): string;
  /** Another fresh TEST-NET address (rate-limit keys cleared), e.g. for a second "device". */
  freshIp(): Promise<string>;
  /** BFF headers: client credentials + the end user's IP/UA as the BFF reports them. */
  client(app: ClientApp, options?: { ip?: string }): Record<string, string>;
  /** Requests through a BFF with a Bearer access token. */
  as(app: ClientApp, accessToken: string, options?: { ip?: string }): BearerClient;
  /** A fresh, tracked (cleaned up) email address. */
  newEmail(label?: string): string;
  /** Tracks a user id for cleanup (ids created outside `signup`/`bootstrapAdmin`). */
  track(userId: string): void;
  /** POST /auth/signup through the student BFF (expects 202) and returns the new user. */
  signup(options?: {
    email?: string;
    password?: string;
    displayName?: string;
  }): Promise<SignedUpUser>;
  /** Marks the email verified directly in SQL (for tests that are not about verification). */
  verifyEmailViaSql(userId: string): Promise<void>;
  /**
   * What the worker does for the newest `EmailVerificationRequested` / `PasswordResetRequested`
   * outbox event of the user (D10 + §14): computes the raw token, stores its SHA-256 and
   * returns the raw token, as the mailed link would carry it.
   */
  issueTokenLikeWorker(userId: string, purpose: OneTimeTokenPurpose): Promise<string>;
  /** POST /auth/login (expects 200) and returns the parsed AuthResult. */
  login(app: ClientApp, email: string, password?: string): Promise<AuthResult>;
  /** A verified ADMIN account through the CLI's BootstrapAdmin use case. */
  bootstrapAdmin(): Promise<SignedUpUser>;
  /** Grants INSTRUCTOR through AccessFacade.grantRole (source `admin`). */
  promoteToInstructor(userId: string, adminId: string): Promise<void>;
}

/** Asserts an RFC 7807 problem response and returns its body. */
export function expectProblem(
  res: request.Response,
  status: number,
  code?: string,
): ProblemDetails {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(PROBLEM_JSON_CONTENT_TYPE).toBe('application/problem+json');
  const problem = ProblemDetailsSchema.parse(res.body) as ProblemDetails;
  expect(problem.status).toBe(status);
  if (code !== undefined) expect(problem.code).toBe(code);
  // The request id is echoed in the header and is the problem's traceId.
  const requestId = res.headers['x-request-id'];
  expect(typeof requestId).toBe('string');
  expect(problem.traceId).toBe(requestId);
  return problem;
}

/** Problem bodies of equivalent requests differ only in traceId. */
export function withoutTraceId(body: unknown): Record<string, unknown> {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.traceId;
  return rest;
}

export function useE2eApp(): E2eHarness {
  const pg = useIntegrationDatabase({ max: 4 });
  const itRedis = useIntegrationRedis();
  const ips = new TestNetIpAllocator();
  const tag = `ep-e2e-${randomUUID().slice(0, 8)}`;
  const emails = new Set<string>();
  const userIds = new Set<string>();
  let app: NestExpressApplication | undefined;
  let currentIp: string | undefined;

  const available = (): boolean => pg.available && itRedis.available;

  const running = (): NestExpressApplication => {
    if (app === undefined) throw new Error('e2e app not started (Postgres/Redis unavailable?)');
    return app;
  };

  async function freshIp(): Promise<string> {
    const ip = ips.allocate();
    if (itRedis.available) await itRedis.redis.del(...ipRateLimitKeys(ip));
    return ip;
  }

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await NestTest.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    setupApp(app);
    await app.init();
    // For fixtures created in the file's own beforeAll hooks (each test then gets its own).
    currentIp = await freshIp();
  });

  beforeEach(async () => {
    currentIp = available() ? await freshIp() : ips.allocate();
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) await cleanup();
    } finally {
      await rm(E2E_APP_ENV.keysDir, { recursive: true, force: true });
      process.env = E2E_APP_ENV.savedEnv;
    }
  });

  /** Everything the file created: users and their data, then the Redis keys it touched. */
  async function cleanup(): Promise<void> {
    const db = pg.db;
    if (emails.size > 0) {
      const rows = await db
        .selectFrom('identity.users')
        .select('id')
        .where('email', 'in', [...emails])
        .execute();
      for (const row of rows) userIds.add(row.id);
    }
    const ids = [...userIds];
    const keys: string[] = [];
    if (ids.length > 0) {
      const sessions = await db
        .selectFrom('identity.sessions')
        .select('id')
        .where('userId', 'in', ids)
        .execute();
      keys.push(...sessions.map((s) => `auth:revoked:sid:${s.id}`));
      for (const id of ids) {
        keys.push(`rl:verify-resend:u:${id}`, `rl:signup-existing-notice:u:${id}`);
      }
    }
    for (const email of emails) {
      const hmac = createHmac('sha256', TEST_ENV.LOGIN_EMAIL_HMAC_KEY)
        .update(email, 'utf8')
        .digest('hex');
      keys.push(`rl:login:e:${hmac}`, `rl:forgot:e:${hmac}`);
      for (const ip of ips.all()) keys.push(`rl:login:eip:${hmac}:${ip}`);
    }
    for (const ip of ips.all()) keys.push(...ipRateLimitKeys(ip));
    for (let i = 0; i < keys.length; i += 500) await itRedis.redis.del(...keys.slice(i, i + 500));

    await deleteUsersTestData(db, ids);
    // Failed logins for unknown emails have no user id; they carry this file's TEST-NET IPs.
    const testIps = ips.all();
    if (testIps.length > 0) {
      await db.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await trx
          .deleteFrom('identity.securityEvents')
          .where('userId', 'is', null)
          .where(sql<boolean>`ip = any(${sql.val(testIps)}::inet[])`)
          .execute();
      });
    }
  }

  function client(appName: ClientApp, options: { ip?: string } = {}): Record<string, string> {
    const ip = options.ip ?? currentIp;
    if (ip === undefined) throw new Error('client(): no test IP (called outside a test?)');
    return {
      'x-client-id': `${appName}-bff`,
      'x-client-secret': BFF_SECRETS[appName],
      'x-client-ip': ip,
      'x-client-user-agent': E2E_USER_AGENT,
    };
  }

  const http = (): ReturnType<typeof request> => request(running().getHttpServer());

  function as(
    appName: ClientApp,
    accessToken: string,
    options: { ip?: string } = {},
  ): BearerClient {
    const call = (method: HttpMethod, path: string): request.Test =>
      http()
        [method](path)
        .set(client(appName, options))
        .set('authorization', `Bearer ${accessToken}`);
    return {
      call,
      get: (path) => call('get', path),
      post: (path) => call('post', path),
      patch: (path) => call('patch', path),
      delete: (path) => call('delete', path),
    };
  }

  function newEmail(label = 'user'): string {
    const email = `${tag}-${label}-${randomUUID().slice(0, 12)}@example.test`;
    emails.add(email);
    return email;
  }

  async function signup(
    options: { email?: string; password?: string; displayName?: string } = {},
  ): Promise<SignedUpUser> {
    const email = options.email ?? newEmail();
    emails.add(email);
    const password = options.password ?? E2E_PASSWORD;
    const res = await http()
      .post('/api/v1/auth/signup')
      .set(client('student'))
      .send({ email, password, displayName: options.displayName ?? `${tag} User` });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const row = await pg.db
      .selectFrom('identity.users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    userIds.add(row.id);
    return { userId: row.id, email, password };
  }

  async function verifyEmailViaSql(userId: string): Promise<void> {
    await pg.db
      .updateTable('identity.users')
      .set({ emailVerifiedAt: sql<Date>`now()` })
      .where('id', '=', userId)
      .execute();
  }

  async function issueTokenLikeWorker(
    userId: string,
    purpose: OneTimeTokenPurpose,
  ): Promise<string> {
    const type =
      purpose === 'EMAIL_VERIFICATION'
        ? 'EmailVerificationRequested.v1'
        : 'PasswordResetRequested.v1';
    const event = await pg.db
      .selectFrom('outbox.events')
      .select(['id', 'payload'])
      .where('aggregateId', '=', userId)
      .where('type', '=', type)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const payload = event.payload as Record<string, unknown>;
    const raw = createHmac('sha256', WORKER_EMAIL_TOKEN_SECRET)
      .update(event.id)
      .update(purpose)
      .digest('base64url');
    const requestedAt = new Date(String(payload.requestedAt));
    const ttlMs = purpose === 'PASSWORD_RESET' ? 30 * 60_000 : 24 * 60 * 60_000;
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
          email: String(payload.email),
          sourceEventId: event.id,
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + ttlMs),
        })
        .onConflict((oc) => oc.column('sourceEventId').doNothing())
        .execute();
    });
    return raw;
  }

  async function login(
    appName: ClientApp,
    email: string,
    password = E2E_PASSWORD,
  ): Promise<AuthResult> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set(client(appName))
      .send({ email, password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AuthResultSchema.parse(res.body);
  }

  async function bootstrapAdmin(): Promise<SignedUpUser> {
    const email = newEmail('admin');
    const result = await running()
      .get(BootstrapAdminCommand, { strict: false })
      .execute({ email, displayName: `${tag} Admin`, password: E2E_PASSWORD });
    userIds.add(result.userId);
    return { userId: result.userId, email, password: E2E_PASSWORD };
  }

  async function promoteToInstructor(userId: string, adminId: string): Promise<void> {
    const access = running().get(AccessFacade, { strict: false });
    await pg.db.transaction().execute(async (trx) => {
      await access.grantRole(trx, {
        userId,
        role: 'INSTRUCTOR',
        actorId: adminId,
        reason: 'endpoints e2e: promote to instructor',
        source: { type: 'admin' },
      });
    });
  }

  return {
    pg,
    redis: itRedis,
    get app(): NestExpressApplication {
      return running();
    },
    http,
    skip(ctx: SkippableContext): void {
      pg.skipIfUnavailable(ctx);
      itRedis.skipIfUnavailable(ctx);
    },
    ip(): string {
      if (currentIp === undefined) throw new Error('ip(): called outside a test');
      return currentIp;
    },
    freshIp,
    client,
    as,
    newEmail,
    track(userId: string): void {
      userIds.add(userId);
    },
    signup,
    verifyEmailViaSql,
    issueTokenLikeWorker,
    login,
    bootstrapAdmin,
    promoteToInstructor,
  };
}
