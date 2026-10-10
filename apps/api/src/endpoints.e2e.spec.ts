// Must stay the first import: AppModule validates process.env when it is imported.
import './testing/e2e/apply-e2e-app-env';
import { randomUUID } from 'node:crypto';
import {
  AcceptedResponseSchema,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  type AuthResult,
  AuthResultSchema,
  BanRecordSchema,
  type ClientApp,
  InstructorApplicationDetailSchema,
  InstructorApplicationPageSchema,
  InstructorApplicationSchema,
  JwksResponseSchema,
  MeResponseSchema,
  MyInstructorApplicationsResponseSchema,
  ProfileSchema,
  PublicProfileSchema,
  RefreshResultSchema,
  SessionListResponseSchema,
  SignupResponseSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BFF_SECRETS,
  E2E_PASSWORD,
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
  withoutTraceId,
} from './testing/e2e/e2e-harness';

/*
 * T16: a systematic sweep over every endpoint of design §8 through the REAL AppModule (all
 * four global guards in production order, setupApp's prefix exclusions, validation and
 * Swagger), real Postgres and Redis. One describe per endpoint:
 *
 *   - success: status + the body parsed with its contracts schema
 *   - the auth matrix (client credentials, client allow-list, Bearer, app confinement,
 *     permissions, other users' resources -> 404)
 *   - the documented error codes
 *   - validation (400 problem+json with errors[]) and malformed uuid params
 *
 * plus cross-cutting checks: problem+json + x-request-id, enumeration equivalence, the forgot
 * password response-time floor (lower bound only), JWKS location/caching and the Swagger path
 * set. Skipped locally when Postgres/Redis are unreachable; a failure with CI=true.
 */

const V1 = '/api/v1';
const WEAK_PASSWORD = 'qwertyuiop'; // in the bundled top-10k list, 10 chars (passes the shape)
const FORM = {
  motivation:
    'I have taught programming for ten years and would love to teach on this platform. '.repeat(2),
  expertise: 'TypeScript and Node.js',
  experienceLevel: 'ONLINE',
  portfolioUrl: 'https://example.com/portfolio',
} as const;

/** How a route is protected (design §8 "Auth" column). */
type RouteAuth =
  /** No client credentials, no user (JWKS). */
  | { kind: 'none' }
  /** C + `@Public`. */
  | { kind: 'public' }
  /**
   * C + B. `forbiddenFor`: a fixture app whose token lacks the route's permission (-> 403
   * `forbidden`). `confinedTo` is the app of the token replayed through another BFF (-> 401).
   */
  | { kind: 'bearer'; forbiddenFor?: ClientApp; confinedTo: ClientApp };

interface Fixtures {
  admin: SignedUpUser;
  student: SignedUpUser;
  other: SignedUpUser;
  instructor: SignedUpUser;
  tokens: Record<ClientApp, AuthResult>;
  studentOfOther: AuthResult;
}

describe('§8 endpoint sweep (real AppModule, guards, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };

  beforeAll(async () => {
    if (!e2e.pg.available || !e2e.redis.available) return;
    const admin = await e2e.bootstrapAdmin();
    const student = await e2e.signup();
    const other = await e2e.signup();
    const instructor = await e2e.signup();
    for (const u of [student, other, instructor]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(instructor.userId, admin.userId);
    fx = {
      admin,
      student,
      other,
      instructor,
      tokens: {
        student: await e2e.login('student', student.email),
        instructor: await e2e.login('instructor', instructor.email),
        admin: await e2e.login('admin', admin.email),
      },
      studentOfOther: await e2e.login('student', other.email),
    };
  });

  const otherApp = (app: ClientApp): ClientApp => (app === 'student' ? 'instructor' : 'student');

  function send(req: request.Test, body: object | undefined): request.Test {
    return body === undefined ? req : req.send(body);
  }

  /**
   * The auth matrix of one route. `path`/`body` are evaluated lazily (inside the test), so they
   * may use fixtures. The body is valid where it matters: the guards must answer before the
   * validation pipe, so even a valid request is refused.
   */
  function authMatrix(
    method: HttpMethod,
    path: () => string,
    auth: RouteAuth,
    body?: () => object,
  ): void {
    if (auth.kind === 'none') return;

    it('auth: no client credentials -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(e2e.http()[method](path()), body?.());
      expectProblem(res, 401, 'unauthorized');
    });

    it('auth: wrong client secret -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(
        e2e
          .http()
          [method](path())
          .set({ ...e2e.client('student'), 'x-client-secret': BFF_SECRETS.admin }),
        body?.(),
      );
      expectProblem(res, 401, 'unauthorized');
    });

    it('auth: unknown client id -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(
        e2e
          .http()
          [method](path())
          .set({ ...e2e.client('student'), 'x-client-id': 'mobile-bff' }),
        body?.(),
      );
      expectProblem(res, 401, 'unauthorized');
    });

    if (auth.kind !== 'bearer') return;
    const confined = auth.confinedTo;

    it('auth: client credentials but no Bearer -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(e2e.http()[method](path()).set(e2e.client(confined)), body?.());
      expectProblem(res, 401, 'unauthorized');
    });

    it('auth: a valid Bearer without client credentials -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(
        e2e
          .http()
          [method](path())
          .set('authorization', `Bearer ${fixtures().tokens[confined].accessToken}`),
        body?.(),
      );
      expectProblem(res, 401, 'unauthorized');
    });

    it('auth: a garbage Bearer -> 401 unauthorized', async (ctx) => {
      e2e.skip(ctx);
      const res = await send(e2e.as(confined, 'not.a.jwt').call(method, path()), body?.());
      expectProblem(res, 401, 'unauthorized');
    });

    it(`auth: a ${confined}-app token through another BFF -> 401 unauthorized`, async (ctx) => {
      e2e.skip(ctx);
      const token = fixtures().tokens[confined].accessToken;
      const res = await send(e2e.as(otherApp(confined), token).call(method, path()), body?.());
      expectProblem(res, 401, 'unauthorized');
    });

    const forbiddenFor = auth.forbiddenFor;
    if (forbiddenFor !== undefined) {
      it(`auth: a ${forbiddenFor}-app token lacks the permission -> 403 forbidden`, async (ctx) => {
        e2e.skip(ctx);
        const token = fixtures().tokens[forbiddenFor].accessToken;
        const res = await send(e2e.as(forbiddenFor, token).call(method, path()), body?.());
        expectProblem(res, 403, 'forbidden');
      });
    }
  }

  /** 400 problem+json `validation_failed` with field errors. */
  function expectValidation(res: request.Response, field?: string): void {
    const problem = expectProblem(res, 400, 'validation_failed');
    expect(problem.errors?.length ?? 0).toBeGreaterThan(0);
    if (field !== undefined) expect(problem.errors?.map((e) => e.path)).toContain(field);
  }

  const asStudent = () => e2e.as('student', fixtures().tokens.student.accessToken);
  const asAdmin = () => e2e.as('admin', fixtures().tokens.admin.accessToken);

  /** A throwaway verified student with a PENDING application, logged in to the student app. */
  async function applicant(): Promise<{
    user: SignedUpUser;
    auth: AuthResult;
    applicationId: string;
  }> {
    const user = await e2e.signup();
    await e2e.verifyEmailViaSql(user.userId);
    const auth = await e2e.login('student', user.email);
    const res = await e2e
      .as('student', auth.accessToken)
      .post(`${V1}/me/instructor-applications`)
      .send(FORM)
      .expect(201);
    return { user, auth, applicationId: InstructorApplicationSchema.parse(res.body).id };
  }

  /* ======================================================================================
   * identity
   * ==================================================================================== */

  describe('GET /.well-known/jwks.json', () => {
    it('200 Jwks, Cache-Control public max-age=300, no credentials needed', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/.well-known/jwks.json').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const jwks = JwksResponseSchema.parse(res.body);
      expect(jwks.keys.map((k) => k.kid)).toContain('ed25519-2026-10');
      expect(JSON.stringify(res.body)).not.toContain('"d"');
    });

    it('is served only at the root: /api/... and /api/v1/... are 404', async (ctx) => {
      e2e.skip(ctx);
      for (const path of ['/api/.well-known/jwks.json', `${V1}/.well-known/jwks.json`]) {
        const res = await e2e.http().get(path).set(e2e.client('student'));
        expect(res.status, path).toBe(404);
      }
    });
  });

  describe('POST /auth/signup', () => {
    const path = () => `${V1}/auth/signup`;
    authMatrix('post', path, { kind: 'public' }, () => ({
      email: e2e.newEmail(),
      password: E2E_PASSWORD,
      displayName: 'Matrix',
    }));

    it('202 { status: accepted } for a new email', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: e2e.newEmail(), password: E2E_PASSWORD, displayName: 'New User' })
        .expect(202);
      expect(SignupResponseSchema.parse(res.body)).toEqual({ status: 'accepted' });
    });

    it.for(['admin', 'instructor'] as const)(
      'auth: from the %s BFF -> 403 client_not_allowed',
      async (app, ctx) => {
        e2e.skip(ctx);
        const res = await e2e
          .http()
          .post(path())
          .set(e2e.client(app))
          .send({ email: e2e.newEmail(), password: E2E_PASSWORD, displayName: 'Nope' });
        expectProblem(res, 403, 'client_not_allowed');
      },
    );

    it('enumeration: an existing email gets the same status and body as a new one', async (ctx) => {
      e2e.skip(ctx);
      const existing = await e2e.signup();
      const again = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: existing.email, password: 'another passphrase', displayName: 'Again' });
      const fresh = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: e2e.newEmail(), password: 'another passphrase', displayName: 'Fresh' });
      expect(again.status).toBe(202);
      expect(fresh.status).toBe(again.status);
      expect(again.body).toEqual(fresh.body);
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: 'not-an-email', password: 'short', displayName: '' });
      expectValidation(res, 'email');
    });

    it('422 weak_password for a common password', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: e2e.newEmail(), password: WEAK_PASSWORD, displayName: 'Weak' });
      expectProblem(res, 422, 'weak_password');
    });

    it('429 + Retry-After after 10 signups from one client IP', async (ctx) => {
      e2e.skip(ctx);
      const attempt = () =>
        e2e
          .http()
          .post(path())
          .set(e2e.client('student'))
          .send({ email: e2e.newEmail(), password: E2E_PASSWORD, displayName: 'Many' });
      for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(202);
      const limited = await attempt();
      expectProblem(limited, 429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('POST /auth/login', () => {
    const path = () => `${V1}/auth/login`;
    authMatrix('post', path, { kind: 'public' }, () => ({
      email: fixtures().student.email,
      password: E2E_PASSWORD,
    }));

    it('200 AuthResult', async (ctx) => {
      e2e.skip(ctx);
      const { student } = fixtures();
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: student.email, password: E2E_PASSWORD })
        .expect(200);
      const auth = AuthResultSchema.parse(res.body);
      expect(auth.user).toMatchObject({
        id: student.userId,
        email: student.email,
        emailVerified: true,
        roles: ['STUDENT'],
      });
    });

    it('401 invalid_credentials; unknown email == wrong password (status and body)', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const wrong = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: user.email, password: 'not the password' });
      const unknown = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: e2e.newEmail('nobody'), password: 'not the password' });
      expectProblem(wrong, 401, 'invalid_credentials');
      expectProblem(unknown, 401, 'invalid_credentials');
      expect(withoutTraceId(wrong.body)).toEqual(withoutTraceId(unknown.body));
    });

    it('403 app_access_denied: a student logging in to the admin and instructor apps', async (ctx) => {
      e2e.skip(ctx);
      const { student } = fixtures();
      for (const app of ['admin', 'instructor'] as const) {
        const res = await e2e
          .http()
          .post(path())
          .set(e2e.client(app))
          .send({ email: student.email, password: E2E_PASSWORD });
        expectProblem(res, 403, 'app_access_denied');
      }
    });

    it('403 account_banned only with the correct password (wrong one stays 401)', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      await asAdmin()
        .post(`${V1}/admin/users/${user.userId}/ban`)
        .send({ reason: 'Spamming every course page.' })
        .expect(200);
      const banned = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: user.email, password: E2E_PASSWORD });
      expectProblem(banned, 403, 'account_banned');
      const wrong = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: user.email, password: 'not the password' });
      expectProblem(wrong, 401, 'invalid_credentials');
    });

    it('429 too_many_attempts + Retry-After after 5 failures for one email+IP', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      for (let i = 0; i < 5; i += 1) {
        await e2e
          .http()
          .post(path())
          .set(e2e.client('student'))
          .send({ email: user.email, password: `wrong password ${i}` })
          .expect(401);
      }
      const blocked = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: user.email, password: E2E_PASSWORD });
      expectProblem(blocked, 429, 'too_many_attempts');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: 'nope', password: '' });
      expectValidation(res, 'email');
    });
  });

  describe('POST /auth/refresh', () => {
    const path = () => `${V1}/auth/refresh`;
    authMatrix('post', path, { kind: 'public' }, () => ({ refreshToken: 'x'.repeat(43) }));

    it('200 RefreshResult with a rotated refresh token', async (ctx) => {
      e2e.skip(ctx);
      const auth = await e2e.login('student', fixtures().other.email);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ refreshToken: auth.refreshToken })
        .expect(200);
      const result = RefreshResultSchema.parse(res.body);
      expect(result.refreshToken).toBeDefined();
      expect(result.refreshToken).not.toBe(auth.refreshToken);
    });

    it('401 invalid_refresh_token for an unknown token and for another app', async (ctx) => {
      e2e.skip(ctx);
      const unknown = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ refreshToken: 'x'.repeat(43) });
      expectProblem(unknown, 401, 'invalid_refresh_token');
      const auth = await e2e.login('student', fixtures().other.email);
      const crossApp = await e2e
        .http()
        .post(path())
        .set(e2e.client('admin'))
        .send({ refreshToken: auth.refreshToken });
      expectProblem(crossApp, 401, 'invalid_refresh_token');
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().post(path()).set(e2e.client('student')).send({});
      expectValidation(res, 'refreshToken');
    });
  });

  describe('POST /auth/logout', () => {
    const path = () => `${V1}/auth/logout`;
    authMatrix('post', path, { kind: 'public' }, () => ({ refreshToken: 'x'.repeat(43) }));

    it('204 always: a real token (twice), then an unknown one', async (ctx) => {
      e2e.skip(ctx);
      const auth = await e2e.login('student', fixtures().other.email);
      for (const refreshToken of [auth.refreshToken, auth.refreshToken, 'x'.repeat(43)]) {
        const res = await e2e
          .http()
          .post(path())
          .set(e2e.client('student'))
          .send({ refreshToken })
          .expect(204);
        expect(res.text).toBe('');
      }
      await e2e.as('student', auth.accessToken).get(`${V1}/me`).expect(401);
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ refreshToken: '' });
      expectValidation(res, 'refreshToken');
    });
  });

  describe('POST /auth/logout-all', () => {
    const path = () => `${V1}/auth/logout-all`;
    authMatrix('post', path, { kind: 'bearer', confinedTo: 'student' });

    it('204, and every session of the user (any app) is dead', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const first = await e2e.login('student', user.email);
      const second = await e2e.login('student', user.email);
      await e2e.as('student', first.accessToken).post(path()).expect(204);
      await e2e.as('student', second.accessToken).get(`${V1}/me`).expect(401);
      const refresh = await e2e
        .http()
        .post(`${V1}/auth/refresh`)
        .set(e2e.client('student'))
        .send({ refreshToken: second.refreshToken });
      expectProblem(refresh, 401, 'invalid_refresh_token');
    });
  });

  describe('GET /auth/sessions', () => {
    const path = () => `${V1}/auth/sessions`;
    authMatrix('get', path, { kind: 'bearer', confinedTo: 'student' });

    it('200 { items: SessionView[] } with the current session marked', async (ctx) => {
      e2e.skip(ctx);
      const auth = fixtures().tokens.student;
      const res = await asStudent().get(path()).expect(200);
      const { items } = SessionListResponseSchema.parse(res.body);
      expect(items.find((s) => s.current)?.id).toBe(auth.sessionId);
    });
  });

  describe('DELETE /auth/sessions/:sessionId', () => {
    const path = (id: string) => `${V1}/auth/sessions/${id}`;
    authMatrix('delete', () => path(randomUUID()), { kind: 'bearer', confinedTo: 'student' });

    it('204 for my other session, which is then dead', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const keep = await e2e.login('student', user.email);
      const end = await e2e.login('student', user.email);
      await e2e.as('student', keep.accessToken).delete(path(end.sessionId)).expect(204);
      await e2e.as('student', end.accessToken).get(`${V1}/me`).expect(401);
      await e2e.as('student', keep.accessToken).get(`${V1}/me`).expect(200);
    });

    it("404 session_not_found for an unknown id and for another user's session (not 403)", async (ctx) => {
      e2e.skip(ctx);
      const unknown = await asStudent().delete(path(randomUUID()));
      expectProblem(unknown, 404, 'session_not_found');
      const foreign = await asStudent().delete(path(fixtures().studentOfOther.sessionId));
      expectProblem(foreign, 404, 'session_not_found');
      // ...and the other user's session survived.
      await e2e.as('student', fixtures().studentOfOther.accessToken).get(`${V1}/me`).expect(200);
    });

    it('400 for a malformed uuid', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asStudent().delete(path('not-a-uuid')), 'sessionId');
    });
  });

  describe('POST /auth/email/verification-requests', () => {
    const path = () => `${V1}/auth/email/verification-requests`;
    authMatrix('post', path, { kind: 'bearer', confinedTo: 'student' });

    it('202 { status: accepted } for an unverified user; 429 + Retry-After past 3 / h', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const auth = await e2e.login('student', user.email);
      for (let i = 0; i < 3; i += 1) {
        const res = await e2e.as('student', auth.accessToken).post(path()).expect(202);
        expect(AcceptedResponseSchema.parse(res.body)).toEqual({ status: 'accepted' });
      }
      const limited = await e2e.as('student', auth.accessToken).post(path());
      expectProblem(limited, 429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('409 email_already_verified', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asStudent().post(path()), 409, 'email_already_verified');
    });
  });

  describe('POST /auth/email/verify', () => {
    const path = () => `${V1}/auth/email/verify`;
    authMatrix('post', path, { kind: 'public' }, () => ({ token: 'x'.repeat(43) }));

    it('204 with the token the worker mails (D10), idempotent on repeat', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const token = await e2e.issueTokenLikeWorker(user.userId, 'EMAIL_VERIFICATION');
      for (let i = 0; i < 2; i += 1) {
        await e2e.http().post(path()).set(e2e.client('student')).send({ token }).expect(204);
      }
      const auth = await e2e.login('student', user.email);
      expect(auth.user.emailVerified).toBe(true);
    });

    it('400 invalid_token for an unknown token', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ token: 'x'.repeat(43) });
      expectProblem(res, 400, 'invalid_token');
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().post(path()).set(e2e.client('student')).send({ token: 42 });
      expectValidation(res, 'token');
    });
  });

  describe('POST /auth/password/forgot', () => {
    const path = () => `${V1}/auth/password/forgot`;
    authMatrix('post', path, { kind: 'public' }, () => ({ email: e2e.newEmail() }));

    it('202 always; known == unknown email (status and body); >= 400 ms floor', async (ctx) => {
      e2e.skip(ctx);
      const known = await e2e.signup();
      const timed = async (email: string) => {
        const startedAt = performance.now();
        const res = await e2e.http().post(path()).set(e2e.client('student')).send({ email });
        return { res, ms: performance.now() - startedAt };
      };
      const forKnown = await timed(known.email);
      const forUnknown = await timed(e2e.newEmail('nobody'));
      expect(forKnown.res.status).toBe(202);
      expect(forUnknown.res.status).toBe(202);
      expect(AcceptedResponseSchema.parse(forKnown.res.body)).toEqual({ status: 'accepted' });
      expect(forUnknown.res.body).toEqual(forKnown.res.body);
      // Lower bound only (design §8: padded to a 400 ms floor); never an upper bound.
      expect(forKnown.ms).toBeGreaterThanOrEqual(400);
      expect(forUnknown.ms).toBeGreaterThanOrEqual(400);
    });

    it('400 validation_failed with errors[] for a malformed email (shape only)', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ email: 'not-an-email' });
      expectValidation(res, 'email');
    });
  });

  describe('POST /auth/password/reset', () => {
    const path = () => `${V1}/auth/password/reset`;
    authMatrix('post', path, { kind: 'public' }, () => ({
      token: 'x'.repeat(43),
      newPassword: 'a brand new passphrase',
    }));

    /** A user with a live reset token (forgot -> worker issues the token). */
    async function withResetToken(): Promise<{ user: SignedUpUser; token: string }> {
      const user = await e2e.signup();
      await e2e
        .http()
        .post(`${V1}/auth/password/forgot`)
        .set(e2e.client('student'))
        .send({ email: user.email })
        .expect(202);
      return { user, token: await e2e.issueTokenLikeWorker(user.userId, 'PASSWORD_RESET') };
    }

    it('204; the new password works and existing sessions are signed out', async (ctx) => {
      e2e.skip(ctx);
      const { user, token } = await withResetToken();
      const before = await e2e.login('student', user.email);
      await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ token, newPassword: 'a brand new passphrase' })
        .expect(204);
      await e2e.as('student', before.accessToken).get(`${V1}/me`).expect(401);
      await e2e.login('student', user.email, 'a brand new passphrase');
    });

    it('422 weak_password with a valid token', async (ctx) => {
      e2e.skip(ctx);
      const { token } = await withResetToken();
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ token, newPassword: WEAK_PASSWORD });
      expectProblem(res, 422, 'weak_password');
    });

    it('400 invalid_token for an unknown token', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ token: 'x'.repeat(43), newPassword: 'a brand new passphrase' });
      expectProblem(res, 400, 'invalid_token');
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e
        .http()
        .post(path())
        .set(e2e.client('student'))
        .send({ token: 'x', newPassword: 'short' });
      expectValidation(res, 'newPassword');
    });
  });

  describe('POST /auth/password/change', () => {
    const path = () => `${V1}/auth/password/change`;
    authMatrix('post', path, { kind: 'bearer', confinedTo: 'student' }, () => ({
      currentPassword: E2E_PASSWORD,
      newPassword: 'a brand new passphrase',
    }));

    it('204; other sessions are signed out, the calling one stays', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const caller = await e2e.login('student', user.email);
      const otherSession = await e2e.login('student', user.email);
      await e2e
        .as('student', caller.accessToken)
        .post(path())
        .send({ currentPassword: E2E_PASSWORD, newPassword: 'a brand new passphrase' })
        .expect(204);
      await e2e.as('student', otherSession.accessToken).get(`${V1}/me`).expect(401);
      await e2e.as('student', caller.accessToken).get(`${V1}/me`).expect(200);
    });

    it('400 invalid_current_password', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const auth = await e2e.login('student', user.email);
      const res = await e2e
        .as('student', auth.accessToken)
        .post(path())
        .send({ currentPassword: 'not the password', newPassword: 'a brand new passphrase' });
      expectProblem(res, 400, 'invalid_current_password');
    });

    it('422 weak_password', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const auth = await e2e.login('student', user.email);
      const res = await e2e
        .as('student', auth.accessToken)
        .post(path())
        .send({ currentPassword: E2E_PASSWORD, newPassword: WEAK_PASSWORD });
      expectProblem(res, 422, 'weak_password');
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await asStudent().post(path()).send({ currentPassword: '' });
      expectValidation(res);
    });
  });

  /* ======================================================================================
   * users
   * ==================================================================================== */

  describe('GET /me', () => {
    const path = () => `${V1}/me`;
    authMatrix('get', path, { kind: 'bearer', confinedTo: 'student' });

    it('200 Me in each app, with app-scoped permissions', async (ctx) => {
      e2e.skip(ctx);
      const { tokens, student, admin } = fixtures();
      const me = MeResponseSchema.parse((await asStudent().get(path()).expect(200)).body);
      expect(me).toMatchObject({ id: student.userId, app: 'student', roles: ['STUDENT'] });
      expect(me.permissions).not.toContain('user:read:any');
      const asAdminMe = MeResponseSchema.parse(
        (await e2e.as('admin', tokens.admin.accessToken).get(path()).expect(200)).body,
      );
      expect(asAdminMe).toMatchObject({ id: admin.userId, app: 'admin' });
      expect(asAdminMe.permissions).toContain('user:read:any');
      const asInstructor = MeResponseSchema.parse(
        (await e2e.as('instructor', tokens.instructor.accessToken).get(path()).expect(200)).body,
      );
      expect(asInstructor.roles).toEqual(['STUDENT', 'INSTRUCTOR']);
    });
  });

  describe('GET /me/profile', () => {
    const path = () => `${V1}/me/profile`;
    authMatrix('get', path, { kind: 'bearer', confinedTo: 'student' });

    it('200 Profile', async (ctx) => {
      e2e.skip(ctx);
      const profile = ProfileSchema.parse((await asStudent().get(path()).expect(200)).body);
      expect(profile.userId).toBe(fixtures().student.userId);
    });
  });

  describe('PATCH /me/profile', () => {
    const path = () => `${V1}/me/profile`;
    authMatrix('patch', path, { kind: 'bearer', confinedTo: 'student' }, () => ({
      headline: 'Matrix',
    }));

    it('200 Profile', async (ctx) => {
      e2e.skip(ctx);
      const res = await asStudent()
        .patch(path())
        .send({ headline: 'Learning every day', bio: null })
        .expect(200);
      expect(ProfileSchema.parse(res.body)).toMatchObject({
        userId: fixtures().student.userId,
        headline: 'Learning every day',
        bio: null,
      });
    });

    it('400 validation_failed with errors[]: empty body, oversized headline', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asStudent().patch(path()).send({}));
      expectValidation(
        await asStudent()
          .patch(path())
          .send({ headline: 'h'.repeat(61) }),
        'headline',
      );
    });
  });

  describe('GET /users/:userId/profile', () => {
    const path = (id: string) => `${V1}/users/${id}/profile`;
    authMatrix('get', () => path(randomUUID()), { kind: 'public' });

    it('200 PublicProfile without a user', async (ctx) => {
      e2e.skip(ctx);
      const { instructor } = fixtures();
      const res = await e2e
        .http()
        .get(path(instructor.userId))
        .set(e2e.client('student'))
        .expect(200);
      expect(PublicProfileSchema.parse(res.body)).toMatchObject({
        id: instructor.userId,
        isInstructor: true,
      });
    });

    it('404 user_not_found for an unknown and for a banned user', async (ctx) => {
      e2e.skip(ctx);
      const unknown = await e2e.http().get(path(randomUUID())).set(e2e.client('student'));
      expectProblem(unknown, 404, 'user_not_found');
      const user = await e2e.signup();
      await asAdmin()
        .post(`${V1}/admin/users/${user.userId}/ban`)
        .send({ reason: 'Spamming every course page.' })
        .expect(200);
      const banned = await e2e.http().get(path(user.userId)).set(e2e.client('student'));
      expectProblem(banned, 404, 'user_not_found');
    });

    it('400 for a malformed uuid', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(
        await e2e.http().get(path('not-a-uuid')).set(e2e.client('student')),
        'userId',
      );
    });
  });

  describe('POST /me/instructor-applications', () => {
    const path = () => `${V1}/me/instructor-applications`;
    authMatrix(
      'post',
      path,
      { kind: 'bearer', confinedTo: 'student', forbiddenFor: 'admin' },
      () => FORM,
    );

    it('201 Application + Location; 409 application_already_pending on a second one', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      await e2e.verifyEmailViaSql(user.userId);
      const auth = await e2e.login('student', user.email);
      const res = await e2e.as('student', auth.accessToken).post(path()).send(FORM).expect(201);
      const application = InstructorApplicationSchema.parse(res.body);
      expect(application).toMatchObject({ status: 'PENDING', applicantId: user.userId });
      expect(res.headers.location).toBe(`${V1}/instructor-applications/${application.id}`);
      const again = await e2e.as('student', auth.accessToken).post(path()).send(FORM);
      expectProblem(again, 409, 'application_already_pending');
    });

    it('403 email_not_verified', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const auth = await e2e.login('student', user.email);
      const res = await e2e.as('student', auth.accessToken).post(path()).send(FORM);
      expectProblem(res, 403, 'email_not_verified');
    });

    it('409 already_instructor', async (ctx) => {
      e2e.skip(ctx);
      const auth = await e2e.login('student', fixtures().instructor.email);
      const res = await e2e.as('student', auth.accessToken).post(path()).send(FORM);
      expectProblem(res, 409, 'already_instructor');
    });

    it('400 validation_failed with errors[] for a malformed body', async (ctx) => {
      e2e.skip(ctx);
      const res = await asStudent()
        .post(path())
        .send({ ...FORM, motivation: 'too short', experienceLevel: 'GURU' });
      expectValidation(res, 'motivation');
    });
  });

  describe('GET /me/instructor-applications', () => {
    const path = () => `${V1}/me/instructor-applications`;
    authMatrix('get', path, { kind: 'bearer', confinedTo: 'student', forbiddenFor: 'admin' });

    it('200 { items } with only my applications', async (ctx) => {
      e2e.skip(ctx);
      const { auth, applicationId } = await applicant();
      const res = await e2e.as('student', auth.accessToken).get(path()).expect(200);
      const { items } = MyInstructorApplicationsResponseSchema.parse(res.body);
      expect(items.map((a) => a.id)).toEqual([applicationId]);
    });
  });

  describe('POST /me/instructor-applications/:id/withdraw', () => {
    const path = (id: string) => `${V1}/me/instructor-applications/${id}/withdraw`;
    authMatrix('post', () => path(randomUUID()), {
      kind: 'bearer',
      confinedTo: 'student',
      forbiddenFor: 'admin',
    });

    it('200 Application (WITHDRAWN); 409 invalid_state_transition on repeat', async (ctx) => {
      e2e.skip(ctx);
      const { auth, applicationId } = await applicant();
      const res = await e2e.as('student', auth.accessToken).post(path(applicationId)).expect(200);
      expect(InstructorApplicationSchema.parse(res.body).status).toBe('WITHDRAWN');
      const again = await e2e.as('student', auth.accessToken).post(path(applicationId));
      expectProblem(again, 409, 'invalid_state_transition');
    });

    it("404 not_found for an unknown id and for another user's application (not 403)", async (ctx) => {
      e2e.skip(ctx);
      const { applicationId } = await applicant();
      expectProblem(await asStudent().post(path(randomUUID())), 404, 'not_found');
      expectProblem(await asStudent().post(path(applicationId)), 404, 'not_found');
    });

    it('a malformed uuid is 404 not_found (the ownership check runs before the pipe)', async (ctx) => {
      // Deliberate (InstructorApplicationOwnership): with only `:own`, PoliciesGuard asks the
      // ownership resolver before the param pipe runs, and an id that cannot exist is "not
      // found". §8 lists 404 (and no 400) for this route.
      e2e.skip(ctx);
      expectProblem(await asStudent().post(path('not-a-uuid')), 404, 'not_found');
    });
  });

  describe('GET /instructor-applications/:id', () => {
    const path = (id: string) => `${V1}/instructor-applications/${id}`;
    authMatrix('get', () => path(randomUUID()), {
      kind: 'bearer',
      confinedTo: 'student',
      forbiddenFor: 'instructor',
    });

    it('200 Application + transitions[] for the applicant (own) and an admin (any)', async (ctx) => {
      e2e.skip(ctx);
      const { auth, applicationId, user } = await applicant();
      const own = await e2e.as('student', auth.accessToken).get(path(applicationId)).expect(200);
      const detail = InstructorApplicationDetailSchema.parse(own.body);
      expect(detail).toMatchObject({ id: applicationId, applicant: { id: user.userId } });
      expect(detail.transitions).toHaveLength(1);
      InstructorApplicationDetailSchema.parse(
        (await asAdmin().get(path(applicationId)).expect(200)).body,
      );
    });

    it("404 not_found for another user's application (not 403) and an unknown one", async (ctx) => {
      e2e.skip(ctx);
      const { applicationId } = await applicant();
      expectProblem(await asStudent().get(path(applicationId)), 404, 'not_found');
      expectProblem(await asStudent().get(path(randomUUID())), 404, 'not_found');
      expectProblem(await asAdmin().get(path(randomUUID())), 404, 'not_found');
    });

    it('400 for a malformed uuid (admin, `:any`); 404 for an applicant (`:own`)', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().get(path('not-a-uuid')), 'id');
      expectProblem(await asStudent().get(path('not-a-uuid')), 404, 'not_found');
    });
  });

  describe('GET /admin/instructor-applications', () => {
    const path = (query = '') => `${V1}/admin/instructor-applications${query}`;
    authMatrix('get', () => path(), {
      kind: 'bearer',
      confinedTo: 'admin',
      forbiddenFor: 'student',
    });

    it('200 { items, nextCursor } (PENDING by default), paginated', async (ctx) => {
      e2e.skip(ctx);
      const first = await applicant();
      await applicant();
      const page = InstructorApplicationPageSchema.parse(
        (await asAdmin().get(path('?status=PENDING&limit=1')).expect(200)).body,
      );
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const all = InstructorApplicationPageSchema.parse(
        (await asAdmin().get(path('?limit=100')).expect(200)).body,
      );
      expect(all.items.every((a) => a.status === 'PENDING')).toBe(true);
      // Other files never leave PENDING applications behind, so ours fit in one page.
      expect(all.items.map((a) => a.id)).toContain(first.applicationId);
    });

    it('400 validation_failed for a bad status or limit', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().get(path('?status=MAYBE')), 'status');
      expectValidation(await asAdmin().get(path('?limit=101')), 'limit');
    });
  });

  describe('POST /admin/instructor-applications/:id/approve', () => {
    const path = (id: string) => `${V1}/admin/instructor-applications/${id}/approve`;
    authMatrix(
      'post',
      () => path(randomUUID()),
      { kind: 'bearer', confinedTo: 'admin', forbiddenFor: 'student' },
      () => ({}),
    );

    it('200 Application (APPROVED); 409 version_conflict / invalid_state_transition', async (ctx) => {
      e2e.skip(ctx);
      const { applicationId, user } = await applicant();
      const stale = await asAdmin().post(path(applicationId)).send({ expectedVersion: 7 });
      expectProblem(stale, 409, 'version_conflict');
      const res = await asAdmin()
        .post(path(applicationId))
        .send({ note: 'Welcome aboard', expectedVersion: 1 })
        .expect(200);
      expect(InstructorApplicationSchema.parse(res.body)).toMatchObject({
        status: 'APPROVED',
        version: 2,
      });
      expectProblem(
        await asAdmin().post(path(applicationId)).send({}),
        409,
        'invalid_state_transition',
      );
      await e2e.login('instructor', user.email);
    });

    it('403 self_decision_forbidden: an admin approving their own application', async (ctx) => {
      e2e.skip(ctx);
      const { admin } = fixtures();
      const asStudentApp = await e2e.login('student', admin.email);
      const created = await e2e
        .as('student', asStudentApp.accessToken)
        .post(`${V1}/me/instructor-applications`)
        .send(FORM)
        .expect(201);
      const own = InstructorApplicationSchema.parse(created.body).id;
      expectProblem(await asAdmin().post(path(own)).send({}), 403, 'self_decision_forbidden');
      expectProblem(
        await asAdmin().post(`${V1}/admin/instructor-applications/${own}/reject`).send({
          reason: 'Rejecting my own application.',
        }),
        403,
        'self_decision_forbidden',
      );
      // Leave nothing PENDING for the queue tests of later runs.
      await e2e
        .as('student', asStudentApp.accessToken)
        .post(`${V1}/me/instructor-applications/${own}/withdraw`)
        .expect(200);
    });

    it('404 not_found for an unknown application', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asAdmin().post(path(randomUUID())).send({}), 404, 'not_found');
    });

    it('400 for a malformed uuid and a malformed body', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().post(path('not-a-uuid')).send({}), 'id');
      expectValidation(
        await asAdmin().post(path(randomUUID())).send({ expectedVersion: 0 }),
        'expectedVersion',
      );
    });
  });

  describe('POST /admin/instructor-applications/:id/reject', () => {
    const path = (id: string) => `${V1}/admin/instructor-applications/${id}/reject`;
    const reason = 'Please add a portfolio first.';
    authMatrix(
      'post',
      () => path(randomUUID()),
      { kind: 'bearer', confinedTo: 'admin', forbiddenFor: 'student' },
      () => ({ reason }),
    );

    it('200 Application (REJECTED); 409 invalid_state_transition on repeat', async (ctx) => {
      e2e.skip(ctx);
      const { applicationId } = await applicant();
      const res = await asAdmin().post(path(applicationId)).send({ reason }).expect(200);
      const rejected = InstructorApplicationSchema.parse(res.body);
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.transitions.at(-1)?.reason).toBe(reason);
      expectProblem(
        await asAdmin().post(path(applicationId)).send({ reason }),
        409,
        'invalid_state_transition',
      );
    });

    it('409 version_conflict for a stale expectedVersion', async (ctx) => {
      e2e.skip(ctx);
      const { applicationId } = await applicant();
      expectProblem(
        await asAdmin().post(path(applicationId)).send({ reason, expectedVersion: 9 }),
        409,
        'version_conflict',
      );
      await asAdmin().post(path(applicationId)).send({ reason }).expect(200);
    });

    it('404 not_found for an unknown application', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asAdmin().post(path(randomUUID())).send({ reason }), 404, 'not_found');
    });

    it('400 for a missing reason and a malformed uuid', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().post(path(randomUUID())).send({}), 'reason');
      expectValidation(await asAdmin().post(path('not-a-uuid')).send({ reason }), 'id');
    });
  });

  describe('GET /admin/users', () => {
    const path = (query = '') => `${V1}/admin/users${query}`;
    authMatrix('get', () => path(), {
      kind: 'bearer',
      confinedTo: 'admin',
      forbiddenFor: 'student',
    });

    it('200 { items: AdminUserRow[], nextCursor } filtered by q and role', async (ctx) => {
      e2e.skip(ctx);
      const { instructor } = fixtures();
      const res = await asAdmin()
        .get(path(`?q=${encodeURIComponent(instructor.email)}&role=INSTRUCTOR`))
        .expect(200);
      const page = AdminUserPageSchema.parse(res.body);
      expect(page.items.map((u) => [u.id, u.roles])).toEqual([
        [instructor.userId, ['STUDENT', 'INSTRUCTOR']],
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('400 validation_failed for a too-short q or a bad role', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().get(path('?q=ab')), 'q');
      expectValidation(await asAdmin().get(path('?role=STUDENT')), 'role');
    });
  });

  describe('GET /admin/users/:userId', () => {
    const path = (id: string) => `${V1}/admin/users/${id}`;
    authMatrix('get', () => path(randomUUID()), {
      kind: 'bearer',
      confinedTo: 'admin',
      forbiddenFor: 'student',
    });

    it('200 { user, roles, bans[], activeSessionCount }', async (ctx) => {
      e2e.skip(ctx);
      const { student } = fixtures();
      const detail = AdminUserDetailSchema.parse(
        (await asAdmin().get(path(student.userId)).expect(200)).body,
      );
      expect(detail).toMatchObject({ user: { id: student.userId }, roles: ['STUDENT'], bans: [] });
      expect(detail.activeSessionCount).toBeGreaterThanOrEqual(1);
    });

    it('404 user_not_found', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asAdmin().get(path(randomUUID())), 404, 'user_not_found');
    });

    it('400 for a malformed uuid', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().get(path('not-a-uuid')), 'userId');
    });
  });

  describe('POST /admin/users/:userId/ban', () => {
    const path = (id: string) => `${V1}/admin/users/${id}/ban`;
    const reason = 'Spamming every course page.';
    authMatrix(
      'post',
      () => path(randomUUID()),
      { kind: 'bearer', confinedTo: 'admin', forbiddenFor: 'student' },
      () => ({ reason }),
    );

    it('200 BanRecord; the user is signed out at once; 409 already_banned', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      const auth = await e2e.login('student', user.email);
      const res = await asAdmin().post(path(user.userId)).send({ reason }).expect(200);
      expect(BanRecordSchema.parse(res.body)).toMatchObject({
        userId: user.userId,
        bannedBy: fixtures().admin.userId,
        reason,
        liftedAt: null,
      });
      await e2e.as('student', auth.accessToken).get(`${V1}/me`).expect(401);
      expectProblem(
        await asAdmin().post(path(user.userId)).send({ reason }),
        409,
        'already_banned',
      );
    });

    it('409 cannot_ban_self and 409 target_is_admin', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(
        await asAdmin().post(path(fixtures().admin.userId)).send({ reason }),
        409,
        'cannot_ban_self',
      );
      const secondAdmin = await e2e.bootstrapAdmin();
      expectProblem(
        await asAdmin().post(path(secondAdmin.userId)).send({ reason }),
        409,
        'target_is_admin',
      );
    });

    it('404 user_not_found', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(
        await asAdmin().post(path(randomUUID())).send({ reason }),
        404,
        'user_not_found',
      );
    });

    it('400 for a short reason and a malformed uuid', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(
        await asAdmin().post(path(randomUUID())).send({ reason: 'short' }),
        'reason',
      );
      expectValidation(await asAdmin().post(path('not-a-uuid')).send({ reason }), 'userId');
    });
  });

  describe('POST /admin/users/:userId/unban', () => {
    const path = (id: string) => `${V1}/admin/users/${id}/unban`;
    authMatrix(
      'post',
      () => path(randomUUID()),
      { kind: 'bearer', confinedTo: 'admin', forbiddenFor: 'student' },
      () => ({}),
    );

    it('200 (the lifted BanRecord); the user can log in again; 409 not_banned on repeat', async (ctx) => {
      e2e.skip(ctx);
      const user = await e2e.signup();
      await asAdmin()
        .post(`${V1}/admin/users/${user.userId}/ban`)
        .send({ reason: 'Spamming every course page.' })
        .expect(200);
      const res = await asAdmin()
        .post(path(user.userId))
        .send({ reason: 'Appeal accepted' })
        .expect(200);
      const lifted = BanRecordSchema.parse(res.body);
      expect(lifted).toMatchObject({ userId: user.userId, liftReason: 'Appeal accepted' });
      expect(lifted.liftedAt).not.toBeNull();
      await e2e.login('student', user.email);
      expectProblem(await asAdmin().post(path(user.userId)).send({}), 409, 'not_banned');
    });

    it('404 user_not_found', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asAdmin().post(path(randomUUID())).send({}), 404, 'user_not_found');
    });

    it('400 for a malformed uuid and a blank reason', async (ctx) => {
      e2e.skip(ctx);
      expectValidation(await asAdmin().post(path('not-a-uuid')).send({}), 'userId');
      expectValidation(await asAdmin().post(path(randomUUID())).send({ reason: ' ' }), 'reason');
    });
  });

  /* ======================================================================================
   * cross-cutting
   * ==================================================================================== */

  describe('format', () => {
    it('echoes the inbound x-request-id on success and errors (problem+json traceId)', async (ctx) => {
      e2e.skip(ctx);
      const ok = `e2e-${randomUUID()}`;
      const success = await asStudent().get(`${V1}/me`).set('x-request-id', ok).expect(200);
      expect(success.headers['x-request-id']).toBe(ok);
      expect(success.headers['content-type']).toMatch(/^application\/json/);

      const failed = `e2e-${randomUUID()}`;
      const error = await e2e.http().get(`${V1}/me`).set('x-request-id', failed);
      expectProblem(error, 401, 'unauthorized');
      expect(error.headers['x-request-id']).toBe(failed);
      expect(error.body.traceId).toBe(failed);
    });

    it('generates an x-request-id when none is sent', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/.well-known/jwks.json').expect(200);
      expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    });

    it('an unknown route is a 404 problem+json', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await asStudent().get(`${V1}/no-such-route`), 404);
    });
  });

  describe('GET /api/docs-json (Swagger)', () => {
    /** Every §8 route as an OpenAPI path + method. */
    const SECTION_8: readonly (readonly [string, HttpMethod | 'put'])[] = [
      ['/.well-known/jwks.json', 'get'],
      [`${V1}/auth/signup`, 'post'],
      [`${V1}/auth/login`, 'post'],
      [`${V1}/auth/refresh`, 'post'],
      [`${V1}/auth/logout`, 'post'],
      [`${V1}/auth/logout-all`, 'post'],
      [`${V1}/auth/sessions`, 'get'],
      [`${V1}/auth/sessions/{sessionId}`, 'delete'],
      [`${V1}/auth/email/verification-requests`, 'post'],
      [`${V1}/auth/email/verify`, 'post'],
      [`${V1}/auth/password/forgot`, 'post'],
      [`${V1}/auth/password/reset`, 'post'],
      [`${V1}/auth/password/change`, 'post'],
      [`${V1}/me`, 'get'],
      [`${V1}/me/profile`, 'get'],
      [`${V1}/me/profile`, 'patch'],
      [`${V1}/users/{userId}/profile`, 'get'],
      [`${V1}/me/instructor-applications`, 'post'],
      [`${V1}/me/instructor-applications`, 'get'],
      [`${V1}/me/instructor-applications/{id}/withdraw`, 'post'],
      [`${V1}/instructor-applications/{id}`, 'get'],
      [`${V1}/admin/instructor-applications`, 'get'],
      [`${V1}/admin/instructor-applications/{id}/approve`, 'post'],
      [`${V1}/admin/instructor-applications/{id}/reject`, 'post'],
      [`${V1}/admin/users`, 'get'],
      [`${V1}/admin/users/{userId}`, 'get'],
      [`${V1}/admin/users/{userId}/ban`, 'post'],
      [`${V1}/admin/users/{userId}/unban`, 'post'],
      // Phase 2 media (catalog-media design §8); covered by modules/media/media.e2e.spec.ts.
      [`${V1}/media/uploads`, 'post'],
      [`${V1}/media/uploads/{assetId}`, 'get'],
      [`${V1}/media/uploads/{assetId}`, 'delete'],
      [`${V1}/media/uploads/{assetId}/part-urls`, 'post'],
      [`${V1}/media/uploads/{assetId}/complete`, 'post'],
      [`${V1}/media/assets`, 'get'],
      [`${V1}/media/assets/{assetId}`, 'get'],
      // Phase 2 catalog A (P2-T9); covered by modules/catalog/catalog.e2e.spec.ts.
      [`${V1}/instructor/courses`, 'get'],
      [`${V1}/instructor/courses`, 'post'],
      [`${V1}/courses/{courseId}`, 'get'],
      [`${V1}/courses/{courseId}`, 'patch'],
      [`${V1}/courses/{courseId}`, 'delete'],
      [`${V1}/courses/{courseId}/thumbnail`, 'put'],
      [`${V1}/courses/{courseId}/thumbnail`, 'delete'],
      [`${V1}/courses/{courseId}/curriculum`, 'get'],
      [`${V1}/courses/{courseId}/curriculum/order`, 'put'],
      [`${V1}/courses/{courseId}/sections`, 'post'],
      [`${V1}/courses/{courseId}/sections/{sectionId}`, 'patch'],
      [`${V1}/courses/{courseId}/sections/{sectionId}`, 'delete'],
      [`${V1}/courses/{courseId}/sections/{sectionId}/lectures`, 'post'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}`, 'patch'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}`, 'delete'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}/article`, 'get'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}/article`, 'put'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}/media`, 'put'],
      [`${V1}/courses/{courseId}/lectures/{lectureId}/media`, 'delete'],
      [`${V1}/admin/categories`, 'get'],
      [`${V1}/admin/categories`, 'post'],
      [`${V1}/admin/categories/order`, 'put'],
      [`${V1}/admin/categories/{id}`, 'patch'],
      [`${V1}/admin/categories/{id}`, 'delete'],
      // Phase 2 catalog B (P2-T10); covered by modules/catalog/catalog-lifecycle.e2e.spec.ts.
      [`${V1}/courses/{courseId}/submit`, 'post'],
      [`${V1}/courses/{courseId}/withdraw`, 'post'],
      [`${V1}/courses/{courseId}/archive`, 'post'],
      [`${V1}/courses/{courseId}/restore`, 'post'],
      [`${V1}/courses/{courseId}/history`, 'get'],
      [`${V1}/admin/course-reviews`, 'get'],
      [`${V1}/admin/course-revisions/{revisionId}`, 'get'],
      [`${V1}/admin/courses/{courseId}/revisions/{revisionId}/approve`, 'post'],
      [`${V1}/admin/courses/{courseId}/revisions/{revisionId}/reject`, 'post'],
      [`${V1}/admin/courses`, 'get'],
      [`${V1}/admin/courses/{courseId}/takedown`, 'post'],
      [`${V1}/admin/courses/{courseId}/restore`, 'post'],
    ];

    it('documents exactly the §8 operations (plus health probes)', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/api/docs-json').expect(200);
      const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
      const documented = Object.entries(paths)
        .filter(([path]) => !path.startsWith('/api/health'))
        .flatMap(([path, item]) =>
          Object.keys(item)
            .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
            .map((method) => `${method.toUpperCase()} ${path}`),
        )
        .sort();
      const expected = SECTION_8.map(([path, method]) => `${method.toUpperCase()} ${path}`).sort();
      expect(documented).toEqual(expected);
    });
  });
});
