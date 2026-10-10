// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE, DbHealthIndicator, indicatorResult } from '@udemy/nest-common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import { AuthMetadataReader } from '../auth';
import { REDIS, RedisHealthIndicator } from '../redis';
import { GLOBAL_THROTTLER } from '../throttler';
import { HealthController } from './health.controller';
import { S3HealthIndicator } from './s3-health.indicator';

/** No real Postgres/Redis: clients are replaced, readiness is driven by stubbed indicators. */
const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = {
  status: 'ready',
  quit: vi.fn(async () => 'OK'),
  disconnect: vi.fn(),
};
const dbHealth = { check: vi.fn(async (key: string) => indicatorResult(key, 'up')) };
const redisHealth = { check: vi.fn(async (key: string) => indicatorResult(key, 'up')) };
const s3Health = { check: vi.fn(async (key: string) => indicatorResult(key, 'up')) };

describe('Health endpoints (full AppModule, DB mocked)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(DbHealthIndicator)
      .useValue(dbHealth)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(RedisHealthIndicator)
      .useValue(redisHealth)
      .overrideProvider(S3HealthIndicator)
      .useValue(s3Health)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      bufferLogs: true,
    });
    setupApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    expect(fakeDatabase.destroy).toHaveBeenCalled();
    expect(fakeRedis.quit).toHaveBeenCalled();
  });

  it('is public and exempt from client auth (probes do not go through a BFF)', () => {
    const route = new AuthMetadataReader().describe(
      HealthController.prototype.ready,
      HealthController,
    );

    expect(route).toEqual({
      security: { kind: 'public', level: 'controller' },
      client: { kind: 'none', level: 'controller' },
      ingress: { kind: 'default' },
      problems: [],
    });
  });

  it('is exempt from the global per-IP throttler (named, so a bare @SkipThrottle() is not enough)', () => {
    expect(Reflect.getMetadata(`THROTTLER:SKIP${GLOBAL_THROTTLER}`, HealthController)).toBe(true);
  });

  it('GET /api/health/live answers 200 without touching the database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);

    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(dbHealth.check).not.toHaveBeenCalled();
  });

  it('is not versioned (no /v1 prefix)', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(404);
  });

  it('GET /api/health/ready answers 200 when the database, Redis and S3 are up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      details: { database: { status: 'up' }, redis: { status: 'up' }, s3: { status: 'up' } },
    });
  });

  it('GET /api/health/ready answers 503 when object storage is down', async () => {
    s3Health.check.mockImplementationOnce(async (key: string) =>
      indicatorResult(key, 'down', { message: 'Object storage is unreachable' }),
    );

    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);

    expect(res.body).toMatchObject({
      status: 503,
      details: { database: { status: 'up' }, redis: { status: 'up' }, s3: { status: 'down' } },
    });
  });

  it('GET /api/health/ready answers 503 when Redis is down', async () => {
    redisHealth.check.mockImplementationOnce(async (key: string) =>
      indicatorResult(key, 'down', { message: 'Redis is unreachable' }),
    );

    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);

    expect(res.body).toMatchObject({
      status: 503,
      details: { database: { status: 'up' }, redis: { status: 'down' } },
    });
  });

  it('GET /api/health/ready answers 503 problem+json when the database is down', async () => {
    dbHealth.check.mockImplementationOnce(async (key: string) =>
      indicatorResult(key, 'down', { message: 'Database is unreachable' }),
    );

    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 503,
      title: 'Service Unavailable',
      details: { database: { status: 'down' } },
    });
  });
});
