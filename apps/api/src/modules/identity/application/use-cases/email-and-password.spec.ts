import { beforeEach, describe, expect, it } from 'vitest';
import {
  EmailAlreadyVerified,
  InvalidCurrentPassword,
  InvalidEmail,
  InvalidOneTimeToken,
  VerificationRateLimited,
  WeakPassword,
} from '../../domain/identity.errors';
import { clientOf, FakePasswordHasher, principalOf } from '../testing/identity.fakes';
import {
  createIdentityHarness,
  type IdentityHarness,
  PASSWORD,
  seedAccount,
} from '../testing/identity.harness';
import { FORGOT_PASSWORD_RESPONSE_FLOOR_MS } from './request-password-reset.command';

const DAY_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 30 * 60_000;
const NEW_PASSWORD = 'a brand new passphrase';

describe('email verification and password use cases', () => {
  let h: IdentityHarness;
  let userId: string;
  const email = 'jane@example.com';
  const student = clientOf('student');

  beforeEach(() => {
    h = createIdentityHarness();
    userId = seedAccount(h, { email, roles: ['INSTRUCTOR'] });
  });

  const login = (client = student, password = PASSWORD) =>
    h.login.execute({ email, password, client });

  const issue = (
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    rawToken: string,
    overrides: { email?: string; ttlMs?: number } = {},
  ) =>
    h.oneTimeTokens.issue({
      userId,
      purpose,
      rawToken,
      email: overrides.email ?? email,
      ttlMs: overrides.ttlMs ?? (purpose === 'PASSWORD_RESET' ? RESET_TTL_MS : DAY_MS),
    });

  const account = () => h.store.accounts.get(userId);

  describe('RequestEmailVerificationCommand', () => {
    it('emits EmailVerificationRequested{RESEND} with the DB clock under the user lock', async () => {
      await h.requestEmailVerification.execute(principalOf(userId, 'sid-1'));

      expect(h.events.published).toEqual([
        {
          type: 'EmailVerificationRequested',
          payload: {
            userId,
            email,
            displayName: 'Test User',
            reason: 'RESEND',
            requestedAt: h.clock.now.toISOString(),
          },
        },
      ]);
      expect(h.accounts.locks).toContainEqual({ userId, mode: 'update' });
    });

    it('answers 409 for a verified address without counting it', async () => {
      const verified = seedAccount(h, { email: 'v@example.com', verified: true });
      await expect(
        h.requestEmailVerification.execute(principalOf(verified, 'sid-1')),
      ).rejects.toBeInstanceOf(EmailAlreadyVerified);
      expect(h.limiter.countOf('rl:verify-resend:')).toBe(0);
      expect(h.events.published).toHaveLength(0);
    });

    it('allows 3 per hour per user, then 429', async () => {
      for (let i = 0; i < 3; i += 1) {
        await h.requestEmailVerification.execute(principalOf(userId, 'sid-1'));
      }
      await expect(
        h.requestEmailVerification.execute(principalOf(userId, 'sid-1')),
      ).rejects.toBeInstanceOf(VerificationRateLimited);
      expect(h.events.published).toHaveLength(3);
      expect(h.limiter.counts.get(`rl:verify-resend:u:${userId}`)).toBe(4);
    });
  });

  describe('VerifyEmailCommand', () => {
    it('consumes the token, verifies the email, logs and emits EmailVerified', async () => {
      const token = issue('EMAIL_VERIFICATION', 'raw-verify');
      await h.verifyEmail.execute({ token: 'raw-verify' });

      expect(account()?.emailVerifiedAt).toEqual(h.clock.now);
      expect(token.consumedAt).toEqual(h.clock.now);
      expect(h.securityLog.types()).toEqual(['EMAIL_VERIFIED']);
      expect(h.events.types()).toEqual(['EmailVerified']);
      // Per-user lock first (schema doc §6 lock order).
      expect(h.accounts.locks).toEqual([{ userId, mode: 'update' }]);
    });

    it('is idempotent: the same consumed token answers success again, without new events', async () => {
      issue('EMAIL_VERIFICATION', 'raw-verify');
      await h.verifyEmail.execute({ token: 'raw-verify' });
      await expect(h.verifyEmail.execute({ token: 'raw-verify' })).resolves.toBeUndefined();
      expect(h.events.types()).toEqual(['EmailVerified']);
    });

    it.each([
      ['an unknown token', () => undefined, 'nope'],
      ['an expired token', (t: IdentityHarness) => t.clock.advance(DAY_MS), 'raw'],
      ['a reset token', undefined, 'raw-reset'],
    ])('refuses %s with invalid_token', async (_name, arrange, presented) => {
      issue('EMAIL_VERIFICATION', 'raw');
      issue('PASSWORD_RESET', 'raw-reset');
      arrange?.(h);
      await expect(h.verifyEmail.execute({ token: presented })).rejects.toBeInstanceOf(
        InvalidOneTimeToken,
      );
      expect(account()?.emailVerifiedAt).toBeNull();
    });

    it('refuses a superseded (invalidated) token', async () => {
      issue('EMAIL_VERIFICATION', 'first');
      issue('EMAIL_VERIFICATION', 'second');
      await expect(h.verifyEmail.execute({ token: 'first' })).rejects.toBeInstanceOf(
        InvalidOneTimeToken,
      );
      await h.verifyEmail.execute({ token: 'second' });
      expect(account()?.emailVerifiedAt).not.toBeNull();
    });

    it('refuses a token mailed to an address that is no longer the account email', async () => {
      issue('EMAIL_VERIFICATION', 'raw', { email: 'old@example.com' });
      await expect(h.verifyEmail.execute({ token: 'raw' })).rejects.toBeInstanceOf(
        InvalidOneTimeToken,
      );
    });

    it('a consumed token does not succeed again once the email changed', async () => {
      issue('EMAIL_VERIFICATION', 'raw');
      await h.verifyEmail.execute({ token: 'raw' });
      const stored = account();
      if (stored !== undefined) stored.email = 'new@example.com';
      await expect(h.verifyEmail.execute({ token: 'raw' })).rejects.toBeInstanceOf(
        InvalidOneTimeToken,
      );
    });
  });

  describe('RequestPasswordResetCommand', () => {
    it('emits PasswordResetRequested for a known email, behind the 400 ms floor', async () => {
      await expect(
        h.requestPasswordReset.execute({ email: ' Jane@Example.com ', client: student }),
      ).resolves.toBe('requested');

      expect(h.floor.floors).toEqual([FORGOT_PASSWORD_RESPONSE_FLOOR_MS]);
      expect(h.events.published).toEqual([
        {
          type: 'PasswordResetRequested',
          payload: {
            userId,
            email,
            displayName: 'Test User',
            requestedAt: h.clock.now.toISOString(),
          },
        },
      ]);
      expect(h.securityLog.types()).toEqual(['PASSWORD_RESET_REQUESTED']);
    });

    it('does nothing for an unknown email, but counts it and pays the same floor', async () => {
      await expect(
        h.requestPasswordReset.execute({ email: 'ghost@example.com', client: student }),
      ).resolves.toBe('unknown_email');
      expect(h.floor.floors).toEqual([FORGOT_PASSWORD_RESPONSE_FLOOR_MS]);
      expect(h.events.published).toHaveLength(0);
      expect(h.limiter.countOf('rl:forgot:e:')).toBe(1);
      expect(h.limiter.countOf('rl:forgot:ip:')).toBe(1);
    });

    it('drops silently over 3 per hour per email', async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        outcomes.push(await h.requestPasswordReset.execute({ email, client: student }));
      }
      expect(outcomes).toEqual(['requested', 'requested', 'requested', 'rate_limited']);
      expect(h.events.published).toHaveLength(3);
    });

    it('drops silently over 10 per hour per IP (across emails)', async () => {
      const ip = clientOf('student', '198.51.100.9');
      for (let i = 0; i < 10; i += 1) {
        await h.requestPasswordReset.execute({ email: `x${i}@example.com`, client: ip });
      }
      await expect(h.requestPasswordReset.execute({ email, client: ip })).resolves.toBe(
        'rate_limited',
      );
      expect(h.events.published).toHaveLength(0);
    });

    it('refuses a malformed address (shape only, before any counting)', async () => {
      await expect(
        h.requestPasswordReset.execute({ email: 'not-an-email', client: student }),
      ).rejects.toBeInstanceOf(InvalidEmail);
      expect(h.limiter.counts.size).toBe(0);
    });
  });

  describe('ResetPasswordCommand', () => {
    it('sets the password, verifies the email, invalidates other reset tokens and revokes ALL sessions', async () => {
      const a = await login();
      const b = await login(clientOf('instructor'));
      const token = issue('PASSWORD_RESET', 'raw-reset');
      const pending = issue('EMAIL_VERIFICATION', 'raw-verify');

      await h.resetPassword.execute({
        token: 'raw-reset',
        newPassword: NEW_PASSWORD,
        client: student,
      });

      expect(account()?.passwordHash).toBe(FakePasswordHasher.hashOf(NEW_PASSWORD));
      expect(account()?.passwordChangedAt).toEqual(h.clock.now);
      expect(account()?.emailVerifiedAt).toEqual(h.clock.now);
      expect(token.consumedAt).toEqual(h.clock.now);
      expect(pending.invalidatedAt).toBeNull(); // only reset tokens are invalidated
      for (const sid of [a.sessionId, b.sessionId]) {
        expect(h.sessions.sessions.get(sid)?.revokeReason).toBe('PASSWORD_RESET');
      }
      expect(h.revocations.revoked).toEqual(new Set([a.sessionId, b.sessionId]));
      expect(h.events.published.map((e) => [e.type, e.payload.via])).toEqual([
        ['EmailVerified', undefined],
        ['PasswordChanged', 'RESET'],
      ]);
      expect(h.securityLog.types()).toContain('PASSWORD_CHANGED');
      await expect(login()).rejects.toThrow();
      await expect(login(student, NEW_PASSWORD)).resolves.toBeDefined();
    });

    it('cannot be used twice', async () => {
      issue('PASSWORD_RESET', 'raw-reset');
      await h.resetPassword.execute({
        token: 'raw-reset',
        newPassword: NEW_PASSWORD,
        client: student,
      });
      await expect(
        h.resetPassword.execute({
          token: 'raw-reset',
          newPassword: 'yet another passphrase',
          client: student,
        }),
      ).rejects.toBeInstanceOf(InvalidOneTimeToken);
    });

    it.each([
      ['unknown', 'nope', () => undefined],
      ['expired', 'raw-reset', (t: IdentityHarness) => t.clock.advance(RESET_TTL_MS)],
      ['a verification token', 'raw-verify', () => undefined],
    ])('refuses an %s token before hashing anything', async (_name, presented, arrange) => {
      issue('PASSWORD_RESET', 'raw-reset');
      issue('EMAIL_VERIFICATION', 'raw-verify');
      arrange(h);
      const hashesBefore = h.fakeHasher.hashes;
      await expect(
        h.resetPassword.execute({ token: presented, newPassword: NEW_PASSWORD, client: student }),
      ).rejects.toBeInstanceOf(InvalidOneTimeToken);
      expect(account()?.passwordHash).toBe(FakePasswordHasher.hashOf(PASSWORD));
      expect(h.events.published).toHaveLength(0);
      if (presented !== 'raw-reset') expect(h.fakeHasher.hashes).toBe(hashesBefore);
    });

    it('refuses a token issued to a previous email address', async () => {
      issue('PASSWORD_RESET', 'raw-reset', { email: 'old@example.com' });
      await expect(
        h.resetPassword.execute({ token: 'raw-reset', newPassword: NEW_PASSWORD, client: student }),
      ).rejects.toBeInstanceOf(InvalidOneTimeToken);
    });

    it('applies the password policy (422) and leaves the token usable', async () => {
      const token = issue('PASSWORD_RESET', 'raw-reset');
      await expect(
        h.resetPassword.execute({ token: 'raw-reset', newPassword: 'short', client: student }),
      ).rejects.toBeInstanceOf(WeakPassword);
      expect(token.consumedAt).toBeNull();
    });
  });

  describe('ChangePasswordCommand', () => {
    it('changes the password, revokes every OTHER session and keeps the caller signed in', async () => {
      const current = await login();
      const other = await login(clientOf('instructor'));
      const reset = issue('PASSWORD_RESET', 'raw-reset');

      await expect(
        h.changePassword.execute({
          principal: principalOf(userId, current.sessionId),
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          client: student,
        }),
      ).resolves.toEqual({ revokedCount: 1 });

      expect(account()?.passwordHash).toBe(FakePasswordHasher.hashOf(NEW_PASSWORD));
      expect(h.sessions.sessions.get(current.sessionId)?.revokedAt).toBeNull();
      expect(h.sessions.sessions.get(other.sessionId)?.revokeReason).toBe('PASSWORD_CHANGED');
      expect(h.revocations.revoked).toEqual(new Set([other.sessionId]));
      expect(reset.invalidatedAt).toEqual(h.clock.now);
      expect(h.events.published.map((e) => [e.type, e.payload.via])).toEqual([
        ['PasswordChanged', 'CHANGE'],
      ]);
    });

    it('refuses a wrong current password with 400 invalid_current_password', async () => {
      const current = await login();
      await expect(
        h.changePassword.execute({
          principal: principalOf(userId, current.sessionId),
          currentPassword: 'wrong password!!',
          newPassword: NEW_PASSWORD,
          client: student,
        }),
      ).rejects.toBeInstanceOf(InvalidCurrentPassword);
      expect(h.events.published).toHaveLength(0);
    });

    it('applies the password policy to the new password', async () => {
      const current = await login();
      await expect(
        h.changePassword.execute({
          principal: principalOf(userId, current.sessionId),
          currentPassword: PASSWORD,
          newPassword: email,
          client: student,
        }),
      ).rejects.toBeInstanceOf(WeakPassword);
    });
  });
});
