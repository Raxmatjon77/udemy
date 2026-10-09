import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE, DbHealthIndicator, indicatorResult } from '@udemy/nest-common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { setupApp } from '../../setup-app';

// The config module validates process.env as soon as app.module is imported, so the env
// must be in place before any import runs; vi.hoisted is executed first.
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.LOG_LEVEL = 'silent';
  process.env.SWAGGER_ENABLED = 'false';
});

/** No real Postgres: the pool is replaced, and readiness is driven by a stubbed indicator. */
const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const dbHealth = { check: vi.fn(async (key: string) => indicatorResult(key, 'up')) };

describe('Health endpoints (full AppModule, DB mocked)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(DbHealthIndicator)
      .useValue(dbHealth)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    setupApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    expect(fakeDatabase.destroy).toHaveBeenCalled();
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

  it('GET /api/health/ready answers 200 when the database is up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);

    expect(res.body).toMatchObject({ status: 'ok', details: { database: { status: 'up' } } });
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
