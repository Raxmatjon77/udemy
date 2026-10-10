import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NotFoundError, ValidationError } from '@udemy/nest-common/errors';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service';
import { RedisUnavailableError } from '../redis/redis-unavailable.error';
import { ProblemDetailsFilter } from './problem-details.filter';
import { toProblemDetails } from './to-problem-details';

@Controller('test')
class ThrowingController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('Course 42 was not found', { code: 'course_not_found' });
  }

  @Get('rule')
  rule(): never {
    throw new ValidationError('Price is too low', {
      issues: [{ path: 'price.amount', message: 'Must be at least 1.99' }],
    });
  }

  @Get('dependency-down')
  redisDown(): never {
    throw new RedisUnavailableError({ cause: new Error('connect ECONNREFUSED 10.0.0.7:6379') });
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection to db-internal.local:5432 failed for user admin');
  }
}

async function createApp(isProduction: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ThrowingController],
    providers: [
      { provide: AppConfigService, useValue: { isProduction } },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('ProblemDetailsFilter (production mode)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(true);
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a DomainError to application/problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/test/not-found').expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Course 42 was not found',
      code: 'course_not_found',
      instance: '/test/not-found',
      traceId: expect.any(String),
    });
  });

  it('maps a domain ValidationError to 422 with field errors', async () => {
    const res = await request(app.getHttpServer()).get('/test/rule').expect(422);

    expect(res.body).toMatchObject({
      status: 422,
      code: 'validation',
      errors: [{ path: 'price.amount', message: 'Must be at least 1.99' }],
    });
  });

  it('maps unknown routes (HttpException) to problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/test/nope').expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, title: 'Not Found', instance: '/test/nope' });
  });

  it('fails closed: an unavailable Redis becomes a generic 503 service_unavailable', async () => {
    const res = await request(app.getHttpServer()).get('/test/dependency-down').expect(503);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The service is temporarily unavailable. Please retry later.',
      code: 'service_unavailable',
      instance: '/test/dependency-down',
      traceId: expect.any(String),
    });
    expect(res.text).not.toMatch(/redis|ECONNREFUSED|10\.0\.0\.7/i);
  });

  it('hides internals of unexpected errors', async () => {
    const res = await request(app.getHttpServer()).get('/test/crash').expect(500);

    expect(res.body).toMatchObject({ status: 500, detail: 'An unexpected error occurred.' });
    expect(res.body).not.toHaveProperty('debug');
    expect(res.text).not.toContain('db-internal');
  });
});

describe('ProblemDetailsFilter (development mode)', () => {
  it('includes debug info for unexpected errors', async () => {
    const app = await createApp(false);
    try {
      const res = await request(app.getHttpServer()).get('/test/crash').expect(500);
      expect(res.body.debug).toMatchObject({ name: 'Error', stack: expect.any(String) });
    } finally {
      await app.close();
    }
  });
});

describe('toProblemDetails', () => {
  it('maps a ZodError to 400 with one entry per issue', () => {
    const result = z.object({ title: z.string().min(3) }).safeParse({ title: 'x' });
    if (result.success) throw new Error('expected a validation failure');

    expect(toProblemDetails(result.error, { exposeInternals: false })).toMatchObject({
      status: 400,
      code: 'validation_failed',
      errors: [{ path: 'title', message: expect.any(String) }],
    });
  });

  it('maps exposed body-parser client errors to their status, and nothing else', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const internal = Object.assign(new Error('stream not readable'), {
      status: 500,
      expose: false,
      type: 'stream.not.readable',
    });
    const unexposed = Object.assign(new Error('secret detail'), { status: 400, type: 'x' });

    expect(toProblemDetails(tooLarge, { exposeInternals: false })).toEqual({
      type: 'about:blank',
      title: 'Payload Too Large',
      status: 413,
      detail: 'request entity too large',
    });
    expect(toProblemDetails(internal, { exposeInternals: false }).status).toBe(500);
    expect(toProblemDetails(unexposed, { exposeInternals: false }).status).toBe(500);
  });
});
