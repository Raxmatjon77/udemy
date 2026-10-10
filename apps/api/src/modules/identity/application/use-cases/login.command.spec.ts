import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountBanned,
  AppAccessDenied,
  InvalidCredentials,
  TooManyAttempts,
} from '../../domain/identity.errors';
import { clientOf, FakePasswordHasher } from '../testing/identity.fakes';
import {
  createIdentityHarness,
  type IdentityHarness,
  PASSWORD,
  seedAccount,
} from '../testing/identity.harness';

const DAY_MS = 24 * 60 * 60 * 1000;

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('LoginCommand', () => {
  let h: IdentityHarness;
  const student = clientOf('student');

  beforeEach(() => {
    h = createIdentityHarness();
  });

  it('opens a session with the app lifetimes and returns the AuthResult', async () => {
    const userId = seedAccount(h, { email: 'jane@example.com', verified: true });

    const result = await h.login.execute({
      email: ' JANE@example.com ',
      password: PASSWORD,
      client: student,
    });

    expect(result.user).toEqual({
      id: userId,
      email: 'jane@example.com',
      displayName: 'Test User',
      emailVerified: true,
      roles: ['STUDENT'],
    });
    const session = h.sessions.sessions.get(result.sessionId);
    expect(session).toMatchObject({ userId, clientApp: 'student', createdIp: '203.0.113.7' });
    expect(session?.absoluteExpiresAt.getTime()).toBe(h.clock.now.getTime() + 60 * DAY_MS);
    expect(result.refreshTokenExpiresAt.getTime()).toBe(h.clock.now.getTime() + 14 * DAY_MS);
    expect(h.sessions.tokenByHash(h.refreshTokens.hash(result.refreshToken))).toMatchObject({
      sessionId: result.sessionId,
      parentId: null,
      consumedAt: null,
    });
    expect(h.accessTokens.issued).toEqual([
      { userId, sessionId: result.sessionId, app: 'student', roles: ['STUDENT'] },
    ]);
    expect(h.securityLog.events).toMatchObject([
      { type: 'LOGIN_SUCCEEDED', userId, sessionId: result.sessionId, clientApp: 'student' },
    ]);
    // Login serialises with bans/role changes on the user row.
    expect(h.accounts.locks).toEqual([{ userId, mode: 'share' }]);
  });

  it('lets unverified accounts log in (design §13)', async () => {
    seedAccount(h, { email: 'new@example.com', verified: false });
    const result = await h.login.execute({
      email: 'new@example.com',
      password: PASSWORD,
      client: student,
    });
    expect(result.user.emailVerified).toBe(false);
  });

  it('uses the admin lifetimes (1 h idle, 12 h absolute) in the admin app', async () => {
    seedAccount(h, { email: 'root@example.com', roles: ['ADMIN'] });
    const result = await h.login.execute({
      email: 'root@example.com',
      password: PASSWORD,
      client: clientOf('admin'),
    });
    const session = h.sessions.sessions.get(result.sessionId);
    expect(session?.absoluteExpiresAt.getTime()).toBe(h.clock.now.getTime() + 12 * 60 * 60 * 1000);
    expect(result.refreshTokenExpiresAt.getTime()).toBe(h.clock.now.getTime() + 60 * 60 * 1000);
    expect(result.user.roles).toEqual(['STUDENT', 'ADMIN']);
  });

  it('treats an unknown email exactly like a wrong password, running the dummy verification', async () => {
    seedAccount(h, { email: 'jane@example.com' });

    const unknown = await errorOf(
      h.login.execute({ email: 'nobody@example.com', password: PASSWORD, client: student }),
    );
    const wrong = await errorOf(
      h.login.execute({ email: 'jane@example.com', password: 'wrong password!', client: student }),
    );

    expect(unknown).toBeInstanceOf(InvalidCredentials);
    expect(wrong).toBeInstanceOf(InvalidCredentials);
    expect((unknown as Error).message).toBe((wrong as Error).message);
    expect(h.fakeHasher.dummyVerifies).toBe(1);
    expect(h.securityLog.events).toMatchObject([
      { type: 'LOGIN_FAILED', userId: null, metadata: { cause: 'unknown_email' } },
      { type: 'LOGIN_FAILED', emailHash: null, metadata: { cause: 'wrong_password' } },
    ]);
    // The unknown-account failure stores the email HMAC, never the email.
    expect(h.securityLog.events[0]?.emailHash).toEqual(h.emailHasher.hash('nobody@example.com'));
    // Failures counted for both, whether or not the account exists.
    expect(h.limiter.countOf('rl:login:eip:')).toBe(2);
    expect(h.limiter.countOf('rl:login:e:')).toBe(2);
    expect(h.sessions.sessions.size).toBe(0);
  });

  it('reveals a ban only after the correct password', async () => {
    const userId = seedAccount(h, { email: 'banned@example.com' });
    h.store.ban(userId);

    await expect(
      h.login.execute({
        email: 'banned@example.com',
        password: 'wrong password!',
        client: student,
      }),
    ).rejects.toBeInstanceOf(InvalidCredentials);
    await expect(
      h.login.execute({ email: 'banned@example.com', password: PASSWORD, client: student }),
    ).rejects.toBeInstanceOf(AccountBanned);
    expect(h.sessions.sessions.size).toBe(0);
    expect(h.securityLog.events.at(-1)).toMatchObject({
      type: 'LOGIN_FAILED',
      metadata: { cause: 'banned' },
    });
  });

  it('reveals app_access_denied only after the correct password', async () => {
    seedAccount(h, { email: 'student@example.com' });
    const admin = clientOf('admin');

    await expect(
      h.login.execute({ email: 'student@example.com', password: 'wrong password!', client: admin }),
    ).rejects.toBeInstanceOf(InvalidCredentials);
    await expect(
      h.login.execute({ email: 'student@example.com', password: PASSWORD, client: admin }),
    ).rejects.toBeInstanceOf(AppAccessDenied);
    await expect(
      h.login.execute({
        email: 'student@example.com',
        password: PASSWORD,
        client: clientOf('instructor'),
      }),
    ).rejects.toBeInstanceOf(AppAccessDenied);
    expect(h.sessions.sessions.size).toBe(0);
  });

  it('blocks the 6th attempt for one email+IP after 5 failures, even with the right password', async () => {
    seedAccount(h, { email: 'jane@example.com' });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        h.login.execute({
          email: 'jane@example.com',
          password: `wrong ${i} password`,
          client: student,
        }),
      ).rejects.toBeInstanceOf(InvalidCredentials);
    }
    const blocked = await errorOf(
      h.login.execute({ email: 'jane@example.com', password: PASSWORD, client: student }),
    );
    expect(blocked).toBeInstanceOf(TooManyAttempts);
    expect((blocked as TooManyAttempts).retryAfterSeconds).toBeGreaterThan(0);
    expect(h.securityLog.events.at(-1)).toMatchObject({
      type: 'LOGIN_THROTTLED',
      metadata: { limiter: 'email_ip' },
    });

    // Another IP is not blocked for this email (no hard lockout).
    await expect(
      h.login.execute({
        email: 'jane@example.com',
        password: PASSWORD,
        client: clientOf('student', '198.51.100.1'),
      }),
    ).resolves.toMatchObject({ user: { email: 'jane@example.com' } });
  });

  it('applies the same email limiter to unknown emails (no enumeration through 429s)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(
        h.login.execute({ email: 'ghost@example.com', password: PASSWORD, client: student }),
      ).rejects.toBeInstanceOf(InvalidCredentials);
    }
    await expect(
      h.login.execute({ email: 'ghost@example.com', password: PASSWORD, client: student }),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it('limits every attempt per IP (30 / 10 min)', async () => {
    seedAccount(h, { email: 'jane@example.com' });
    for (let i = 0; i < 30; i += 1) {
      await h.login.execute({ email: 'jane@example.com', password: PASSWORD, client: student });
    }
    await expect(
      h.login.execute({ email: 'jane@example.com', password: PASSWORD, client: student }),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it('clears the email+IP failure counter after a successful login', async () => {
    seedAccount(h, { email: 'jane@example.com' });
    for (let i = 0; i < 4; i += 1) {
      await h.login
        .execute({ email: 'jane@example.com', password: 'nope nope nope', client: student })
        .catch(() => undefined);
    }
    await h.login.execute({ email: 'jane@example.com', password: PASSWORD, client: student });
    expect(h.limiter.countOf('rl:login:eip:')).toBe(0);
    expect(h.limiter.countOf('rl:login:e:')).toBe(4); // the per-email ceiling is not reset
  });

  it('rehashes a hash made with outdated parameters', async () => {
    const userId = seedAccount(h, {
      email: 'old@example.com',
      passwordHash: `${FakePasswordHasher.OUTDATED}${PASSWORD}`,
    });
    await h.login.execute({ email: 'old@example.com', password: PASSWORD, client: student });
    expect((await h.accounts.findById(userId))?.passwordHash).toBe(
      FakePasswordHasher.hashOf(PASSWORD),
    );
  });
});
