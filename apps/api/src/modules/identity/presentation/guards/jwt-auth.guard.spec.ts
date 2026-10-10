import type { ExecutionContext } from '@nestjs/common';
import type { ClientApp, Permission, Role } from '@udemy/contracts';
import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticatedOnly,
  AuthMetadataReader,
  type ClientContext,
  getPrincipal,
  Public,
  RequirePermissions,
  setClientContext,
} from '../../../../shared/auth';
import { toProblemDetails } from '../../../../shared/errors';
import { RedisUnavailableError } from '../../../../shared/redis';
import { AccessTokenAuthenticator } from '../../application/access-token.authenticator';
import { AccessTokenVerifier } from '../../application/ports/access-token-verifier';
import { PermissionResolver } from '../../application/ports/permission-resolver';
import { SessionRevocationStore } from '../../application/ports/session-revocation.store';
import type { AccessTokenClaims } from '../../domain/access-token';
import { AccessTokenExpired, Unauthenticated } from '../../domain/identity.errors';
import { JwtAuthGuard } from './jwt-auth.guard';

const studentClaims: AccessTokenClaims = {
  iss: 'http://localhost:4000',
  aud: 'udemy-api',
  sub: '0199d0a0-0000-7000-8000-000000000001',
  sid: '0199d0a0-0000-7000-8000-000000000002',
  app: 'student',
  roles: ['STUDENT'],
  iat: 1,
  exp: 2,
  jti: '0199d0a0-0000-7000-8000-000000000003',
};

/** Token strings the stub verifier understands. */
const TOKENS: Record<string, AccessTokenClaims | Error> = {
  'valid.student.token': studentClaims,
  'expired.student.token': new AccessTokenExpired(),
  'forged.token.x': new Unauthenticated(),
};

class StubVerifier extends AccessTokenVerifier {
  async verify(token: string): Promise<AccessTokenClaims> {
    const result = TOKENS[token] ?? new Unauthenticated();
    if (result instanceof Error) throw result;
    return result;
  }
}

class FakeRevocations extends SessionRevocationStore {
  revoked = new Set<string>();
  down = false;
  async revoke(sid: string): Promise<void> {
    this.revoked.add(sid);
  }
  async revokeMany(sids: readonly string[]): Promise<void> {
    for (const sid of sids) this.revoked.add(sid);
  }
  async isRevoked(sid: string): Promise<boolean> {
    if (this.down) throw new RedisUnavailableError({ cause: new Error('ECONNREFUSED') });
    return this.revoked.has(sid);
  }
}

class StaticPermissions extends PermissionResolver {
  effectivePermissions(_roles: readonly Role[], _app: ClientApp): ReadonlySet<Permission> {
    return new Set<Permission>(['profile:read:own']);
  }
}

class Routes {
  @Public()
  catalog(): void {}

  @AuthenticatedOnly()
  me(): void {}

  @RequirePermissions('profile:read:own')
  profile(): void {}
}

const studentClient: ClientContext = {
  clientId: 'student-bff',
  app: 'student',
  ip: '203.0.113.7',
  userAgent: 'UA',
};

function request(token: string | undefined, client: ClientContext | null = studentClient): Request {
  const req = {
    headers: token === undefined ? {} : { authorization: token },
    ip: '10.0.0.5',
    socket: {},
  } as unknown as Request;
  if (client !== null) setClientContext(req, client);
  return req;
}

function contextFor(route: keyof Routes, req: Request): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Routes.prototype[route],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function problemOf(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return toProblemDetails(error, { exposeInternals: false });
  }
  throw new Error('expected the guard to reject');
}

describe('JwtAuthGuard', () => {
  let revocations: FakeRevocations;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    revocations = new FakeRevocations();
    guard = new JwtAuthGuard(
      new AuthMetadataReader(),
      new AccessTokenAuthenticator(new StubVerifier(), revocations, new StaticPermissions()),
    );
  });

  it('sets the principal for a valid token of the calling app', async () => {
    const req = request('Bearer valid.student.token');

    await expect(guard.canActivate(contextFor('profile', req))).resolves.toBe(true);
    expect(getPrincipal(req)).toEqual({
      userId: studentClaims.sub,
      sessionId: studentClaims.sid,
      app: 'student',
      roles: ['STUDENT'],
      permissions: new Set(['profile:read:own']),
      tokenId: studentClaims.jti,
    });
  });

  it('401 unauthorized when token.app differs from the client app', async () => {
    const req = request('Bearer valid.student.token', {
      ...studentClient,
      clientId: 'admin-bff',
      app: 'admin',
    });

    expect(await problemOf(guard.canActivate(contextFor('me', req)))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(getPrincipal(req)).toBeUndefined();
  });

  it('401 unauthorized for a revoked session', async () => {
    await revocations.revoke(studentClaims.sid);
    const req = request('Bearer valid.student.token');

    expect(await problemOf(guard.canActivate(contextFor('me', req)))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('503 service_unavailable when Redis is down (fail closed)', async () => {
    revocations.down = true;
    const req = request('Bearer valid.student.token');

    expect(await problemOf(guard.canActivate(contextFor('me', req)))).toMatchObject({
      status: 503,
      code: 'service_unavailable',
    });
    expect(getPrincipal(req)).toBeUndefined();
  });

  it('401 token_expired for an expired token', async () => {
    const req = request('Bearer expired.student.token');

    expect(await problemOf(guard.canActivate(contextFor('me', req)))).toMatchObject({
      status: 401,
      code: 'token_expired',
    });
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty Bearer', 'Bearer '],
    ['a forged token', 'Bearer forged.token.x'],
  ])('401 unauthorized with %s', async (_case, header) => {
    const req = request(header);

    expect(await problemOf(guard.canActivate(contextFor('profile', req)))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
  });

  it('401 when no client was authenticated (tokens are bound to a client app)', async () => {
    const req = request('Bearer valid.student.token', null);

    expect(await problemOf(guard.canActivate(contextFor('me', req)))).toMatchObject({
      status: 401,
    });
  });

  describe('@Public routes', () => {
    it('pass without a token', async () => {
      const req = request(undefined);

      await expect(guard.canActivate(contextFor('catalog', req))).resolves.toBe(true);
      expect(getPrincipal(req)).toBeUndefined();
    });

    it('set the principal when a valid token is present (optional auth)', async () => {
      const req = request('Bearer valid.student.token');

      await expect(guard.canActivate(contextFor('catalog', req))).resolves.toBe(true);
      expect(getPrincipal(req)?.userId).toBe(studentClaims.sub);
    });

    it.each([
      ['an expired token', 'Bearer expired.student.token'],
      ['a forged token', 'Bearer forged.token.x'],
      ['a malformed header', 'Token abc'],
    ])('never reject: %s is ignored', async (_case, header) => {
      const req = request(header);

      await expect(guard.canActivate(contextFor('catalog', req))).resolves.toBe(true);
      expect(getPrincipal(req)).toBeUndefined();
    });

    it('never reject, even when Redis is down', async () => {
      revocations.down = true;
      const req = request('Bearer valid.student.token');

      await expect(guard.canActivate(contextFor('catalog', req))).resolves.toBe(true);
      expect(getPrincipal(req)).toBeUndefined();
    });

    it('ignore tokens on requests without an authenticated client', async () => {
      const req = request('Bearer valid.student.token', null);

      await expect(guard.canActivate(contextFor('catalog', req))).resolves.toBe(true);
      expect(getPrincipal(req)).toBeUndefined();
    });
  });
});
