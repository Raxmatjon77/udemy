import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Global,
  type INestApplication,
  Module,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { JwksResponseSchema } from '@udemy/contracts';
import { createConfigModule, DATABASE } from '@udemy/nest-common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOBAL_PREFIX } from '../../setup-app';
import {
  AuthenticatedOnly,
  AuthSupportModule,
  CurrentPrincipal,
  type Principal,
  Public,
} from '../../shared/auth';
import { apiEnvSchema, AppConfigModule } from '../../shared/config';
import { ErrorsModule } from '../../shared/errors';
import { OutboxModule } from '../../shared/outbox';
import { REDIS } from '../../shared/redis';
import { TEST_ENV } from '../../testing/test-env';
import { AccessTokenIssuer } from './application/ports/access-token-issuer';
import { ClientAuthGuard, IDENTITY_PREFIX_EXCLUSIONS, IdentityModule, JwtAuthGuard } from './index';

/**
 * HTTP-level test of the identity crypto core: JWKS outside the `api` prefix, and the two
 * global guards wired exactly as AppModule will (ClientAuthGuard -> JwtAuthGuard).
 * Permissions come from the real AccessModule. No Postgres; Redis is an in-memory stub.
 */
const STUDENT = {
  'x-client-id': 'student-bff',
  'x-client-secret': 'dev-student-bff-secret-change-me-in-prod',
};
const ADMIN = {
  'x-client-id': 'admin-bff',
  'x-client-secret': 'dev-admin-bff-secret-change-me-in-prod',
};
const USER_ID = '0199d0a0-0000-7000-8000-000000000001';
const SESSION_ID = '0199d0a0-0000-7000-8000-000000000002';

const fakeRedis = { exists: vi.fn(async (_key: string): Promise<number> => 0) };
/** Permission resolution is pure code in AccessFacade: no query reaches the database. */
const fakeDatabase = {};

@Global()
@Module({
  providers: [
    { provide: REDIS, useValue: fakeRedis },
    { provide: DATABASE, useValue: fakeDatabase },
  ],
  exports: [REDIS, DATABASE],
})
class FakeInfrastructureModule {}

@Controller('probe')
class ProbeController {
  @Public()
  @Get()
  open(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal): { userId: string; permissions: string[] } {
    return { userId: principal.userId, permissions: [...principal.permissions] };
  }
}

/** Mirrors the AppModule wiring T8 adds. */
@Module({
  imports: [IdentityModule],
  controllers: [ProbeController],
  providers: [
    { provide: APP_GUARD, useExisting: ClientAuthGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
})
class GuardedAppModule {}

describe('identity over HTTP (JWKS + guards)', () => {
  let app: INestApplication;
  let keysDir: string;
  let issuer: AccessTokenIssuer;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    keysDir = await mkdtemp(join(tmpdir(), 'udemy-jwks-e2e-'));
    for (const kid of ['ed25519-2026-09', 'ed25519-2026-10']) {
      const pem = generateKeyPairSync('ed25519').privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      });
      await writeFile(join(keysDir, `${kid}.pem`), pem, { mode: 0o600 });
    }
    Object.assign(process.env, TEST_ENV, { JWT_KEYS_DIR: keysDir, LOG_LEVEL: 'silent' });

    const moduleRef = await Test.createTestingModule({
      imports: [
        await createConfigModule(apiEnvSchema),
        AppConfigModule,
        ErrorsModule,
        AuthSupportModule,
        OutboxModule,
        FakeInfrastructureModule,
        GuardedAppModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    // What setupApp must do (see the T8 checklist): prefix with the identity exclusions.
    app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: [...IDENTITY_PREFIX_EXCLUSIONS] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    issuer = moduleRef.get(AccessTokenIssuer, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await rm(keysDir, { recursive: true, force: true });
    process.env = savedEnv;
  });

  async function tokenFor(appName: 'student' | 'admin'): Promise<string> {
    const roles = appName === 'admin' ? (['STUDENT', 'ADMIN'] as const) : (['STUDENT'] as const);
    return (await issuer.issue({ userId: USER_ID, sessionId: SESSION_ID, app: appName, roles }))
      .token;
  }

  describe('GET /.well-known/jwks.json', () => {
    it('serves every public key, cacheable for 5 minutes, without any credentials', async () => {
      const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);

      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const jwks = JwksResponseSchema.parse(res.body);
      expect(jwks.keys.map((k) => k.kid)).toEqual(['ed25519-2026-10', 'ed25519-2026-09']);
      expect(JSON.stringify(res.body)).not.toContain('"d"');
    });

    it('lives outside the api prefix and versioning', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/.well-known/jwks.json').expect(404);
      await request(server).get('/api/v1/.well-known/jwks.json').expect(404);
      await request(server).get('/v1/.well-known/jwks.json').expect(404);
    });
  });

  describe('global guards on a prefixed route', () => {
    it('require client credentials (401 problem+json)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe').expect(401);

      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 401, code: 'unauthorized' });
    });

    it('let an authenticated BFF call a @Public route', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/probe')
        .set(STUDENT)
        .expect(200, { ok: true });
    });

    it('authenticate the user from the Bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/me')
        .set(STUDENT)
        .set('authorization', `Bearer ${await tokenFor('student')}`)
        .expect(200);

      expect(res.body.userId).toBe(USER_ID);
      // Student app: baseline + STUDENT permissions (design §4), resolved by AccessFacade.
      expect([...res.body.permissions].sort()).toEqual(
        [
          'instructor_application:create:own',
          'instructor_application:read:own',
          'instructor_application:withdraw:own',
          'profile:read:own',
          'profile:update:own',
          'session:manage:own',
        ].sort(),
      );
      expect(fakeRedis.exists).toHaveBeenCalledWith(`auth:revoked:sid:${SESSION_ID}`);
    });

    it('confine a token to its app: a student token through the admin BFF is 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/me')
        .set(ADMIN)
        .set('authorization', `Bearer ${await tokenFor('student')}`)
        .expect(401);

      expect(res.body).toMatchObject({ code: 'unauthorized' });
    });

    it('reject a revoked session with 401 and fail closed with 503 when Redis is down', async () => {
      const token = await tokenFor('student');
      fakeRedis.exists.mockResolvedValueOnce(1);
      await request(app.getHttpServer())
        .get('/api/v1/probe/me')
        .set(STUDENT)
        .set('authorization', `Bearer ${token}`)
        .expect(401);

      fakeRedis.exists.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/me')
        .set(STUDENT)
        .set('authorization', `Bearer ${token}`)
        .expect(503);
      expect(res.body).toMatchObject({ code: 'service_unavailable' });
    });

    it('require a token on non-public routes', async () => {
      await request(app.getHttpServer()).get('/api/v1/probe/me').set(STUDENT).expect(401);
    });
  });
});
