import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { ClientApp } from '@udemy/contracts';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  AllowClients,
  AuthenticatedOnly,
  AuthMetadataReader,
  ClientIpResolver,
  getClientContext,
  isClientAuthenticated,
  NoClientAuth,
  Public,
} from '../../../../shared/auth';
import type { AppConfigService } from '../../../../shared/config';
import { toProblemDetails } from '../../../../shared/errors';
import { ClientAuthGuard } from './client-auth.guard';

const SECRETS: Record<ClientApp, string> = {
  student: 'student-secret-0123456789',
  instructor: 'instructor-secret-0123456789',
  admin: 'admin-secret-0123456789',
};
const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const config = {
  clientSecretHash: (app: ClientApp) => sha256Hex(SECRETS[app]),
} as unknown as AppConfigService;

class Routes {
  @AuthenticatedOnly()
  anyClient(): void {}

  @Public()
  @NoClientAuth()
  probe(): void {}

  @AuthenticatedOnly()
  @AllowClients('admin')
  adminOnly(): void {}

  @Public()
  @NoClientAuth()
  @AllowClients('admin')
  misconfigured(): void {}
}

function request(headers: Record<string, string | string[]>): Request {
  return { headers, ip: '10.0.0.5', socket: { remoteAddress: '10.0.0.5' } } as unknown as Request;
}

function contextFor(route: keyof Routes, req: Request): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Routes.prototype[route],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function credentials(clientId: string, secret: string): Record<string, string> {
  return {
    'x-client-id': clientId,
    'x-client-secret': secret,
    'x-client-ip': '203.0.113.7',
    'x-client-user-agent': 'Mozilla/5.0 (end user)',
  };
}

function problemOf(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
  } catch (error) {
    return toProblemDetails(error, { exposeInternals: false });
  }
  throw new Error('expected the guard to throw');
}

describe('ClientAuthGuard', () => {
  const guard = new ClientAuthGuard(new AuthMetadataReader(), new ClientIpResolver(), config);

  it.each([
    ['student-bff', 'student'],
    ['instructor-bff', 'instructor'],
    ['admin-bff', 'admin'],
  ] as const)('authenticates %s and sets the client context', (clientId, app) => {
    const req = request(credentials(clientId, SECRETS[app]));

    expect(guard.canActivate(contextFor('anyClient', req))).toBe(true);
    expect(getClientContext(req)).toEqual({
      clientId,
      app,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (end user)',
    });
  });

  it('trusts X-Client-IP / X-Client-User-Agent only after the client is authenticated', () => {
    const req = request(credentials('admin-bff', SECRETS.admin));
    expect(isClientAuthenticated(req)).toBe(false);

    guard.canActivate(contextFor('anyClient', req));

    expect(isClientAuthenticated(req)).toBe(true);
    expect(getClientContext(req)?.ip).toBe('203.0.113.7');
  });

  it.each([
    ['a wrong secret', credentials('student-bff', 'nope')],
    ["another app's secret", credentials('student-bff', SECRETS.admin)],
    ['an unknown client id', credentials('teacher-bff', SECRETS.student)],
    ['a prototype key as client id', credentials('constructor', SECRETS.student)],
    ['no secret', { 'x-client-id': 'student-bff' }],
    ['no client id', { 'x-client-secret': SECRETS.student }],
    ['no headers', {}],
    [
      'duplicated headers',
      { 'x-client-id': ['student-bff', 'student-bff'], 'x-client-secret': SECRETS.student },
    ],
  ])('rejects %s with 401 unauthorized and trusts nothing', (_case, headers) => {
    const req = request(headers);

    expect(problemOf(() => guard.canActivate(contextFor('anyClient', req)))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(isClientAuthenticated(req)).toBe(false);
    expect(getClientContext(req)).toBeUndefined();
  });

  it('@NoClientAuth: passes without credentials and does not trust X-Client-IP', () => {
    const req = request({ 'x-client-ip': '203.0.113.7' });

    expect(guard.canActivate(contextFor('probe', req))).toBe(true);
    expect(isClientAuthenticated(req)).toBe(false);
    expect(getClientContext(req)).toBeUndefined();
    expect(new ClientIpResolver().resolve(req)).toBe('10.0.0.5');
  });

  it('@AllowClients: allows the listed app', () => {
    const req = request(credentials('admin-bff', SECRETS.admin));
    expect(guard.canActivate(contextFor('adminOnly', req))).toBe(true);
  });

  it('@AllowClients: another authenticated app gets 403 client_not_allowed', () => {
    const req = request(credentials('student-bff', SECRETS.student));

    expect(problemOf(() => guard.canActivate(contextFor('adminOnly', req)))).toMatchObject({
      status: 403,
      code: 'client_not_allowed',
    });
  });

  it('@AllowClients: bad credentials are still 401, not 403', () => {
    const req = request(credentials('student-bff', 'nope'));

    expect(problemOf(() => guard.canActivate(contextFor('adminOnly', req)))).toMatchObject({
      status: 401,
    });
  });

  it('denies a route with both @NoClientAuth and @AllowClients', () => {
    const req = request(credentials('admin-bff', SECRETS.admin));

    expect(problemOf(() => guard.canActivate(contextFor('misconfigured', req)))).toMatchObject({
      status: 403,
      code: 'client_not_allowed',
    });
  });
});
