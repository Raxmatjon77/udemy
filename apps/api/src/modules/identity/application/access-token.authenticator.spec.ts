import type { ClientApp, Permission, Role } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ClientContext } from '../../../shared/auth';
import { RedisUnavailableError } from '../../../shared/redis';
import type { AccessTokenClaims } from '../domain/access-token';
import { AccessTokenExpired, Unauthenticated } from '../domain/identity.errors';
import { AccessTokenAuthenticator } from './access-token.authenticator';
import { AccessTokenVerifier } from './ports/access-token-verifier';
import { PermissionResolver } from './ports/permission-resolver';
import { SessionRevocationStore } from './ports/session-revocation.store';

const claims: AccessTokenClaims = {
  iss: 'http://localhost:4000',
  aud: 'udemy-api',
  sub: '0199d0a0-0000-7000-8000-000000000001',
  sid: '0199d0a0-0000-7000-8000-000000000002',
  app: 'admin',
  roles: ['STUDENT', 'ADMIN'],
  iat: 1,
  exp: 2,
  jti: '0199d0a0-0000-7000-8000-000000000003',
};
const adminClient: ClientContext = {
  clientId: 'admin-bff',
  app: 'admin',
  ip: '203.0.113.7',
  userAgent: 'UA',
};

class StubVerifier extends AccessTokenVerifier {
  result: AccessTokenClaims | Error = claims;
  async verify(): Promise<AccessTokenClaims> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class StubRevocations extends SessionRevocationStore {
  revoked = new Set<string>();
  down = false;
  async revoke(): Promise<void> {}
  async revokeMany(): Promise<void> {}
  async isRevoked(sid: string): Promise<boolean> {
    if (this.down) throw new RedisUnavailableError();
    return this.revoked.has(sid);
  }
}

class StubPermissions extends PermissionResolver {
  readonly calls: [readonly Role[], ClientApp][] = [];
  effectivePermissions(roles: readonly Role[], app: ClientApp): ReadonlySet<Permission> {
    this.calls.push([roles, app]);
    return new Set<Permission>(['user:ban:any']);
  }
}

function setup(): {
  auth: AccessTokenAuthenticator;
  verifier: StubVerifier;
  revocations: StubRevocations;
  permissions: StubPermissions;
} {
  const verifier = new StubVerifier();
  const revocations = new StubRevocations();
  const permissions = new StubPermissions();
  return {
    auth: new AccessTokenAuthenticator(verifier, revocations, permissions),
    verifier,
    revocations,
    permissions,
  };
}

describe('AccessTokenAuthenticator', () => {
  it('builds the principal from the claims, permissions from roles + app', async () => {
    const { auth, permissions } = setup();

    const principal = await auth.authenticate('token', adminClient);

    expect(principal).toEqual({
      userId: claims.sub,
      sessionId: claims.sid,
      app: 'admin',
      roles: ['STUDENT', 'ADMIN'],
      permissions: new Set(['user:ban:any']),
      tokenId: claims.jti,
    });
    expect(permissions.calls).toEqual([[['STUDENT', 'ADMIN'], 'admin']]);
  });

  it('rejects a token issued to another app (401 unauthorized)', async () => {
    const { auth, permissions } = setup();

    await expect(
      auth.authenticate('token', { ...adminClient, clientId: 'student-bff', app: 'student' }),
    ).rejects.toBeInstanceOf(Unauthenticated);
    expect(permissions.calls).toHaveLength(0);
  });

  it('rejects a revoked session (401 unauthorized)', async () => {
    const { auth, revocations } = setup();
    revocations.revoked.add(claims.sid);

    await expect(auth.authenticate('token', adminClient)).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('fails closed when Redis is down (503)', async () => {
    const { auth, revocations } = setup();
    revocations.down = true;

    await expect(auth.authenticate('token', adminClient)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });

  it('passes verifier errors through (token_expired stays token_expired)', async () => {
    const { auth, verifier } = setup();
    verifier.result = new AccessTokenExpired();

    await expect(auth.authenticate('token', adminClient)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('checks app confinement before touching Redis', async () => {
    const { auth, revocations } = setup();
    const spy = vi.spyOn(revocations, 'isRevoked');

    await expect(
      auth.authenticate('token', { ...adminClient, app: 'instructor' }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
