// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from './testing/apply-it-app-env';
import { randomInt, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  AuthResultSchema,
  JwksResponseSchema,
  RefreshResultSchema,
  SessionListResponseSchema,
} from '@udemy/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';
import {
  deleteTestUsers,
  useIntegrationDatabase,
  useIntegrationRedis,
} from './testing/integration';

/*
 * The real AppModule over HTTP: all four global guards in their production order, the BFF
 * client credentials, real Postgres + Redis (IT_DATABASE_URL / IT_REDIS_URL; skipped locally
 * when unreachable, a failure with CI=true).
 */
const PASSWORD = 'correct horse battery';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const SECRETS = {
  student: 'dev-student-bff-secret-change-me-in-prod',
  instructor: 'dev-instructor-bff-secret-change-me-in-prod',
  admin: 'dev-admin-bff-secret-change-me-in-prod',
} as const;
type App = keyof typeof SECRETS;

/** What a BFF sends: client credentials + the end user's IP/UA (omit ip to test the fallback). */
function bff(app: App, ip: string | null = randomIp()): Record<string, string> {
  return {
    'x-client-id': `${app}-bff`,
    'x-client-secret': SECRETS[app],
    'x-client-user-agent': UA,
    ...(ip === null ? {} : { 'x-client-ip': ip }),
  };
}

function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

/** Problem bodies differ only in traceId (per request). */
function withoutTrace(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.traceId;
  return rest;
}

describe('API e2e: signup -> login -> sessions -> refresh -> logout (real guards, PG, Redis)', () => {
  const pg = useIntegrationDatabase({ max: 2 });
  const itRedis = useIntegrationRedis();
  const emails: string[] = [];
  let app: NestExpressApplication | undefined;

  const http = () => {
    if (app === undefined) throw new Error('app not started');
    return request(app.getHttpServer());
  };

  beforeAll(async () => {
    if (!pg.available || !itRedis.available) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (pg.available && emails.length > 0) {
      const rows = await pg.db
        .selectFrom('identity.users')
        .select('id')
        .where('email', 'in', emails)
        .execute();
      await deleteTestUsers(
        pg.db,
        rows.map((r) => r.id),
      );
    }
    await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
    process.env = IT_APP_ENV.savedEnv;
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  function newEmail(): string {
    const email = `e2e-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  function signup(email: string, password = PASSWORD): request.Test {
    return http()
      .post('/api/v1/auth/signup')
      .set(bff('student'))
      .send({ email, password, displayName: 'E2E User' });
  }

  it('runs the whole session lifecycle as the student BFF', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    const ip = randomIp();

    // signup: 202, and the outbox has the registration events
    await signup(email).expect(202, { status: 'accepted' });
    const user = await pg.db
      .selectFrom('identity.users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const outbox = await pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', user.id)
      .execute();
    expect(outbox.map((e) => e.type).sort()).toEqual([
      'EmailVerificationRequested.v1',
      'UserRegistered.v1',
    ]);

    // login: 200 AuthResult
    const login = await http()
      .post('/api/v1/auth/login')
      .set(bff('student', ip))
      .send({ email, password: PASSWORD })
      .expect(200);
    const auth = AuthResultSchema.parse(login.body);
    expect(auth.user).toEqual({
      id: user.id,
      email,
      displayName: 'E2E User',
      emailVerified: false,
      roles: ['STUDENT'],
    });

    // sessions: the current one, with the BFF-reported IP and the parsed device
    const sessions = await http()
      .get('/api/v1/auth/sessions')
      .set(bff('student', ip))
      .set('authorization', `Bearer ${auth.accessToken}`)
      .expect(200);
    expect(SessionListResponseSchema.parse(sessions.body).items).toEqual([
      expect.objectContaining({
        id: auth.sessionId,
        app: 'student',
        ip,
        device: 'Safari on macOS',
        current: true,
      }),
    ]);

    // refresh: rotation, then the same old token again within 10 s -> grace (access token only)
    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set(bff('student', ip))
      .send({ refreshToken: auth.refreshToken })
      .expect(200);
    const rotated = RefreshResultSchema.parse(refreshed.body);
    expect(rotated.refreshToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(auth.refreshToken);
    const grace = await http()
      .post('/api/v1/auth/refresh')
      .set(bff('student', ip))
      .send({ refreshToken: auth.refreshToken })
      .expect(200);
    expect(Object.keys(grace.body).sort()).toEqual(['accessToken', 'accessTokenExpiresAt']);

    // logout: 204 (idempotent), then the access token and the refresh token are dead
    for (let i = 0; i < 2; i += 1) {
      await http()
        .post('/api/v1/auth/logout')
        .set(bff('student', ip))
        .send({ refreshToken: rotated.refreshToken })
        .expect(204);
    }
    const revoked = await http()
      .get('/api/v1/auth/sessions')
      .set(bff('student', ip))
      .set('authorization', `Bearer ${rotated.accessToken}`)
      .expect(401);
    expect(revoked.body).toMatchObject({ code: 'unauthorized' });
    const dead = await http()
      .post('/api/v1/auth/refresh')
      .set(bff('student', ip))
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);
    expect(dead.body).toMatchObject({ code: 'invalid_refresh_token' });
    expect(dead.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('confines a student-app token to the student BFF: through the admin client it is 401', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email).expect(202);
    const login = await http()
      .post('/api/v1/auth/login')
      .set(bff('student'))
      .send({ email, password: PASSWORD })
      .expect(200);

    const res = await http()
      .get('/api/v1/auth/sessions')
      .set(bff('admin'))
      .set('authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(401);
    expect(res.body).toMatchObject({ code: 'unauthorized' });

    // ...and its refresh token is refused by the admin BFF too.
    const refresh = await http()
      .post('/api/v1/auth/refresh')
      .set(bff('admin'))
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
    expect(refresh.body).toMatchObject({ code: 'invalid_refresh_token' });
  });

  it('signup: an existing email gets the same status and body as a new one', async (ctx) => {
    skip(ctx);
    const existing = newEmail();
    await signup(existing).expect(202);

    const again = await signup(existing.toUpperCase(), 'a different passphrase');
    const fresh = await signup(newEmail());

    expect(again.status).toBe(202);
    expect(fresh.status).toBe(again.status);
    expect(again.body).toEqual(fresh.body);
    expect(again.body).toEqual({ status: 'accepted' });
  });

  it('login: an unknown email and a wrong password get the same status and body', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email).expect(202);

    const wrong = await http()
      .post('/api/v1/auth/login')
      .set(bff('student'))
      .send({ email, password: 'not the password' });
    const unknown = await http()
      .post('/api/v1/auth/login')
      .set(bff('student'))
      .send({ email: `nobody-${randomUUID()}@example.test`, password: 'not the password' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(withoutTrace(wrong.body as Record<string, unknown>)).toEqual(
      withoutTrace(unknown.body as Record<string, unknown>),
    );
    expect(wrong.body).toMatchObject({ code: 'invalid_credentials' });
  });

  it('login: the 6th attempt for one email+IP after 5 failures is 429 with Retry-After', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email).expect(202);
    const ip = randomIp();
    for (let i = 0; i < 5; i += 1) {
      await http()
        .post('/api/v1/auth/login')
        .set(bff('student', ip))
        .send({ email, password: `wrong password ${i}` })
        .expect(401);
    }
    const blocked = await http()
      .post('/api/v1/auth/login')
      .set(bff('student', ip))
      .send({ email, password: PASSWORD })
      .expect(429);
    expect(blocked.body).toMatchObject({ code: 'too_many_attempts' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('only the student BFF may sign up (403 client_not_allowed)', async (ctx) => {
    skip(ctx);
    const res = await http()
      .post('/api/v1/auth/signup')
      .set(bff('instructor'))
      .send({ email: newEmail(), password: PASSWORD, displayName: 'Nope' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'client_not_allowed' });
  });

  it('a password typed fullwidth at signup logs in typed as ASCII (NFKC)', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email, 'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ').expect(202);
    await http()
      .post('/api/v1/auth/login')
      .set(bff('student'))
      .send({ email, password: PASSWORD })
      .expect(200);
  });

  it('without X-Client-IP the session records the socket address, never "unknown"', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email).expect(202);
    const login = await http()
      .post('/api/v1/auth/login')
      .set(bff('student', null))
      .send({ email, password: PASSWORD })
      .expect(200);
    const sessions = await http()
      .get('/api/v1/auth/sessions')
      .set(bff('student', null))
      .set('authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(200);
    const [session] = SessionListResponseSchema.parse(sessions.body).items;
    expect(session?.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
    // `rl:login:ip:<loopback>` is the one rate-limit key this file shares with every other run
    // and process on this Redis (30 / 10 min): take back this test's hit instead of letting
    // repeated runs drift into 429. (DECR only an existing key: on a missing one it would
    // create a TTL-less -1.)
    const loopbackKey = `rl:login:ip:${session?.ip ?? ''}`;
    if ((await itRedis.redis.exists(loopbackKey)) === 1) await itRedis.redis.decr(loopbackKey);
  });

  it('sessions: deleting an unknown session is 404, a malformed id 400; logout-all is 204', async (ctx) => {
    skip(ctx);
    const email = newEmail();
    await signup(email).expect(202);
    const login = await http()
      .post('/api/v1/auth/login')
      .set(bff('student'))
      .send({ email, password: PASSWORD })
      .expect(200);
    const bearer = `Bearer ${login.body.accessToken as string}`;

    const missing = await http()
      .delete(`/api/v1/auth/sessions/${randomUUID()}`)
      .set(bff('student'))
      .set('authorization', bearer)
      .expect(404);
    expect(missing.body).toMatchObject({ code: 'session_not_found' });
    await http()
      .delete('/api/v1/auth/sessions/not-a-uuid')
      .set(bff('student'))
      .set('authorization', bearer)
      .expect(400);

    await http()
      .post('/api/v1/auth/logout-all')
      .set(bff('student'))
      .set('authorization', bearer)
      .expect(204);
    await http()
      .get('/api/v1/auth/sessions')
      .set(bff('student'))
      .set('authorization', bearer)
      .expect(401);
  });

  it('requires client credentials on auth routes and serves the JWKS without any', async (ctx) => {
    skip(ctx);
    await http().post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x' }).expect(401);
    const jwks = await http().get('/.well-known/jwks.json').expect(200);
    expect(JwksResponseSchema.parse(jwks.body).keys).toHaveLength(1);
  });
});
