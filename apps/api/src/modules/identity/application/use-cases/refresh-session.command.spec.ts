import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidRefreshToken } from '../../domain/identity.errors';
import { clientOf } from '../testing/identity.fakes';
import {
  createIdentityHarness,
  type IdentityHarness,
  PASSWORD,
  seedAccount,
} from '../testing/identity.harness';
import { ConcurrentRotation } from './refresh-session.command';

describe('RefreshSessionCommand', () => {
  let h: IdentityHarness;
  let userId: string;
  const student = clientOf('student', '198.51.100.20');

  beforeEach(() => {
    h = createIdentityHarness();
    userId = seedAccount(h, { email: 'jane@example.com' });
  });

  async function login(client = clientOf('student')) {
    return h.login.execute({ email: 'jane@example.com', password: PASSWORD, client });
  }

  function lastSecurityEvent() {
    return h.securityLog.events.at(-1);
  }

  it('rotates: consumes the token, issues a child, touches the session', async () => {
    const { refreshToken, sessionId } = await login();
    h.clock.advance(60_000);

    const result = await h.refresh.execute({ refreshToken, client: student });

    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken);
    const old = h.sessions.tokenByHash(h.refreshTokens.hash(refreshToken));
    const child = h.sessions.tokenByHash(h.refreshTokens.hash(result.refreshToken ?? ''));
    expect(old?.consumedAt).toEqual(h.clock.now);
    expect(child).toMatchObject({ parentId: old?.id, consumedAt: null, sessionId });
    expect(result.refreshTokenExpiresAt?.getTime()).toBe(
      h.clock.now.getTime() + 14 * 24 * 3600_000,
    );
    expect(h.sessions.sessions.get(sessionId)).toMatchObject({
      lastUsedAt: h.clock.now,
      lastIp: '198.51.100.20',
    });
    expect(h.accessTokens.issued.at(-1)).toEqual({
      userId,
      sessionId,
      app: 'student',
      roles: ['STUDENT'],
    });
  });

  it('grace: the same token again within 10 s gets an access token only', async () => {
    const { refreshToken, sessionId } = await login();
    const first = await h.refresh.execute({ refreshToken, client: student });
    h.clock.advance(9_000);

    const second = await h.refresh.execute({ refreshToken, client: student });

    expect(second.refreshToken).toBeUndefined();
    expect(second.refreshTokenExpiresAt).toBeUndefined();
    expect(second.accessToken).toContain(sessionId);
    expect(h.sessions.sessions.get(sessionId)?.revokedAt).toBeNull();
    expect(
      h.sessions.tokenByHash(h.refreshTokens.hash(first.refreshToken ?? ''))?.consumedAt,
    ).toBeNull();
  });

  it('reuse after the grace window revokes the family, emits SessionCompromiseDetected and sets the sid key', async () => {
    const { refreshToken, sessionId } = await login();
    const rotated = await h.refresh.execute({ refreshToken, client: student });
    h.clock.advance(10_000);

    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toBeInstanceOf(
      InvalidRefreshToken,
    );

    expect(h.sessions.sessions.get(sessionId)).toMatchObject({ revokeReason: 'REUSE_DETECTED' });
    expect(h.revocations.revoked.has(sessionId)).toBe(true);
    expect(h.events.types()).toEqual(['SessionCompromiseDetected']);
    expect(h.events.published[0]?.payload).toMatchObject({
      userId,
      sessionId,
      clientApp: 'student',
    });
    expect(lastSecurityEvent()).toMatchObject({
      type: 'REFRESH_REUSE_DETECTED',
      userId,
      sessionId,
      metadata: { cause: 'reuse_detected' },
    });
    // The legitimate holder of the child token is logged out too (the family is dead).
    await expect(
      h.refresh.execute({ refreshToken: rotated.refreshToken ?? '', client: student }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(lastSecurityEvent()).toMatchObject({ metadata: { cause: 'session_revoked' } });
  });

  it('reuse inside the window but after the child was rotated too is still reuse', async () => {
    const { refreshToken, sessionId } = await login();
    const second = await h.refresh.execute({ refreshToken, client: student });
    await h.refresh.execute({ refreshToken: second.refreshToken ?? '', client: student });

    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toBeInstanceOf(
      InvalidRefreshToken,
    );
    expect(h.sessions.sessions.get(sessionId)?.revokeReason).toBe('REUSE_DETECTED');
  });

  it('rejects unknown tokens without revoking anything', async () => {
    await login();
    await expect(
      h.refresh.execute({ refreshToken: 'not-a-real-token', client: student }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(lastSecurityEvent()).toMatchObject({
      type: 'REFRESH_REJECTED',
      userId: null,
      metadata: { cause: 'unknown_token' },
    });
    expect(h.revocations.revoked.size).toBe(0);
  });

  it('rejects a token presented by another app, without revoking the session', async () => {
    const { refreshToken, sessionId } = await login();
    await expect(
      h.refresh.execute({ refreshToken, client: clientOf('admin') }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(lastSecurityEvent()).toMatchObject({
      metadata: { cause: 'wrong_app', sessionApp: 'student' },
    });
    expect(h.sessions.sessions.get(sessionId)?.revokedAt).toBeNull();
  });

  it('rejects an idle-expired token and an absolutely expired session', async () => {
    const { refreshToken } = await login();
    h.clock.advance(14 * 24 * 3600_000);
    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toBeInstanceOf(
      InvalidRefreshToken,
    );
    expect(lastSecurityEvent()).toMatchObject({ metadata: { cause: 'token_expired' } });

    const fresh = await login();
    h.clock.advance(61 * 24 * 3600_000);
    await expect(
      h.refresh.execute({ refreshToken: fresh.refreshToken, client: student }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(lastSecurityEvent()).toMatchObject({ metadata: { cause: 'session_expired' } });
  });

  it('rejects a revoked session (logout)', async () => {
    const { refreshToken } = await login();
    await h.logout.execute({ refreshToken, client: clientOf('student') });
    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toBeInstanceOf(
      InvalidRefreshToken,
    );
    expect(lastSecurityEvent()).toMatchObject({ metadata: { cause: 'session_revoked' } });
  });

  it('a ban revokes the session on refresh (BANNED) and sets the sid key', async () => {
    const { refreshToken, sessionId } = await login();
    h.store.ban(userId);

    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toBeInstanceOf(
      InvalidRefreshToken,
    );
    expect(h.sessions.sessions.get(sessionId)?.revokeReason).toBe('BANNED');
    expect(h.revocations.revoked.has(sessionId)).toBe(true);
    expect(lastSecurityEvent()).toMatchObject({
      type: 'REFRESH_REJECTED',
      metadata: { cause: 'banned' },
    });
  });

  it('losing the app role revokes the session on refresh (ROLE_LOST)', async () => {
    h.roles.set(userId, ['INSTRUCTOR']);
    const { refreshToken, sessionId } = await login(clientOf('instructor'));
    h.roles.set(userId, []);

    await expect(
      h.refresh.execute({ refreshToken, client: clientOf('instructor') }),
    ).rejects.toBeInstanceOf(InvalidRefreshToken);
    expect(h.sessions.sessions.get(sessionId)?.revokeReason).toBe('ROLE_LOST');
    expect(h.revocations.revoked.has(sessionId)).toBe(true);
  });

  it('mints the access token with fresh roles', async () => {
    const { refreshToken } = await login();
    h.roles.set(userId, ['INSTRUCTOR']);
    await h.refresh.execute({ refreshToken, client: student });
    expect(h.accessTokens.issued.at(-1)?.roles).toEqual(['STUDENT', 'INSTRUCTOR']);
  });

  it('retries once on a concurrent rotation and then takes the grace path', async () => {
    const { refreshToken } = await login();
    // Simulates the other request having rotated between our lock and our insert.
    const realInsert = h.sessions.insertRefreshToken.bind(h.sessions);
    let calls = 0;
    h.sessions.insertRefreshToken = async (trx, token) => {
      calls += 1;
      if (calls === 1) {
        await realInsert(trx, token);
        throw new ConcurrentRotation();
      }
      return realInsert(trx, token);
    };

    const result = await h.refresh.execute({ refreshToken, client: student });
    expect(result.refreshToken).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('fails closed when Redis cannot record a revocation', async () => {
    const { refreshToken } = await login();
    h.store.ban(userId);
    h.revocations.down = true;
    await expect(h.refresh.execute({ refreshToken, client: student })).rejects.toThrow(
      'Redis down',
    );
  });
});
