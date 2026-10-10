import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { ProblemDetailsFilter } from '../errors/problem-details.filter';
import {
  getClientContext,
  getPrincipal,
  isClientAuthenticated,
  setClientContext,
  setPrincipal,
} from './auth-request';
import { CurrentClient, CurrentPrincipal } from './current-principal.decorator';
import type { ClientContext, Principal } from './principal';

/** Plays the role of ClientAuthGuard + JwtAuthGuard: fills the request from test headers. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.headers['x-test-client'] === '1') {
      setClientContext(req, {
        clientId: 'student-bff',
        app: 'student',
        ip: '203.0.113.9',
        userAgent: 'UA',
      });
    }
    if (req.headers['x-test-user'] === '1') {
      setPrincipal(req, {
        userId: 'user-1',
        sessionId: 'sid-1',
        app: 'student',
        roles: ['STUDENT'],
        permissions: new Set(['profile:read:own']),
        tokenId: 'jti-1',
      });
    }
    return true;
  }
}

@Controller('t')
class ProbeController {
  @Get('principal')
  principal(@CurrentPrincipal() principal: Principal): object {
    return { ...principal, permissions: [...principal.permissions] };
  }

  @Get('client')
  client(@CurrentClient() client: ClientContext): ClientContext {
    return client;
  }
}

describe('@CurrentPrincipal / @CurrentClient', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: AppConfigService, useValue: { isProduction: true } },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('injects the principal set by the auth guard', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/principal')
      .set('x-test-user', '1')
      .expect(200);

    expect(res.body).toEqual({
      userId: 'user-1',
      sessionId: 'sid-1',
      app: 'student',
      roles: ['STUDENT'],
      permissions: ['profile:read:own'],
      tokenId: 'jti-1',
    });
  });

  it('injects the client context set by the client guard', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/client')
      .set('x-test-client', '1')
      .expect(200);

    expect(res.body).toEqual({
      clientId: 'student-bff',
      app: 'student',
      ip: '203.0.113.9',
      userAgent: 'UA',
    });
  });

  it.each(['/t/principal', '/t/client'])(
    'answers 500 (programming error) when %s has no state',
    async (path) => {
      const res = await request(app.getHttpServer()).get(path).expect(500);

      expect(res.body).toMatchObject({ status: 500, detail: 'An unexpected error occurred.' });
    },
  );
});

describe('auth request accessors', () => {
  it('start empty and are independent per request', () => {
    const a = {} as Request;
    const b = {} as Request;
    setPrincipal(a, {
      userId: 'u',
      sessionId: 's',
      app: 'admin',
      roles: ['STUDENT', 'ADMIN'],
      permissions: new Set(),
      tokenId: 't',
    });

    expect(getPrincipal(a)?.userId).toBe('u');
    expect(getPrincipal(b)).toBeUndefined();
    expect(getClientContext(a)).toBeUndefined();
    expect(isClientAuthenticated(a)).toBe(false);
  });

  it('cannot be spoofed through string-keyed request properties', () => {
    const req = { principal: { userId: 'evil' }, client: { app: 'admin' } } as unknown as Request;

    expect(getPrincipal(req)).toBeUndefined();
    expect(getClientContext(req)).toBeUndefined();
  });
});
