import { beforeEach, describe, expect, it } from 'vitest';
import { SessionNotFound } from '../../domain/identity.errors';
import { clientOf, principalOf } from '../testing/identity.fakes';
import {
  createIdentityHarness,
  type IdentityHarness,
  PASSWORD,
  seedAccount,
} from '../testing/identity.harness';

describe('session management use cases', () => {
  let h: IdentityHarness;
  let userId: string;
  const student = clientOf('student');

  beforeEach(() => {
    h = createIdentityHarness();
    userId = seedAccount(h, { email: 'jane@example.com', roles: ['INSTRUCTOR'] });
  });

  const login = (client = student) =>
    h.login.execute({ email: 'jane@example.com', password: PASSWORD, client });

  describe('LogoutCommand', () => {
    it('revokes the session (LOGOUT), sets the sid key and logs it; repeating is a silent no-op', async () => {
      const { refreshToken, sessionId } = await login();
      await h.logout.execute({ refreshToken, client: student });

      expect(h.sessions.sessions.get(sessionId)?.revokeReason).toBe('LOGOUT');
      expect(h.revocations.revoked).toEqual(new Set([sessionId]));
      expect(h.securityLog.types().filter((t) => t === 'LOGOUT')).toHaveLength(1);

      await expect(h.logout.execute({ refreshToken, client: student })).resolves.toBeUndefined();
      expect(h.securityLog.types().filter((t) => t === 'LOGOUT')).toHaveLength(1);
    });

    it('also works with an already rotated (consumed) token of the family', async () => {
      const { refreshToken, sessionId } = await login();
      await h.refresh.execute({ refreshToken, client: student });
      await h.logout.execute({ refreshToken, client: student });
      expect(h.sessions.sessions.get(sessionId)?.revokeReason).toBe('LOGOUT');
    });

    it('ignores unknown tokens and tokens of another app', async () => {
      const { refreshToken, sessionId } = await login();
      await expect(
        h.logout.execute({ refreshToken: 'garbage', client: student }),
      ).resolves.toBeUndefined();
      await expect(
        h.logout.execute({ refreshToken, client: clientOf('instructor') }),
      ).resolves.toBeUndefined();
      expect(h.sessions.sessions.get(sessionId)?.revokedAt).toBeNull();
      expect(h.revocations.revoked.size).toBe(0);
    });
  });

  describe('LogoutAllSessionsCommand', () => {
    it('revokes every active session in every app and sets every sid key', async () => {
      const a = await login();
      const b = await login(clientOf('instructor'));
      const c = await login();
      await h.logout.execute({ refreshToken: c.refreshToken, client: student });

      const result = await h.logoutAll.execute({
        principal: principalOf(userId, a.sessionId),
        client: student,
      });

      expect(result).toEqual({ revokedCount: 2 });
      expect(h.sessions.sessions.get(a.sessionId)?.revokeReason).toBe('LOGOUT_ALL');
      expect(h.sessions.sessions.get(b.sessionId)?.revokeReason).toBe('LOGOUT_ALL');
      expect(h.sessions.sessions.get(c.sessionId)?.revokeReason).toBe('LOGOUT');
      expect(h.revocations.revoked).toEqual(new Set([a.sessionId, b.sessionId, c.sessionId]));
      expect(h.securityLog.events.at(-1)).toMatchObject({
        type: 'LOGOUT_ALL',
        metadata: { revokedCount: 2 },
      });
    });
  });

  describe('RevokeSessionCommand', () => {
    it("revokes one of the caller's sessions (USER_REVOKED)", async () => {
      const current = await login();
      const other = await login(clientOf('instructor'));
      await h.revokeSession.execute({
        principal: principalOf(userId, current.sessionId),
        sessionId: other.sessionId,
        client: student,
      });
      expect(h.sessions.sessions.get(other.sessionId)?.revokeReason).toBe('USER_REVOKED');
      expect(h.sessions.sessions.get(current.sessionId)?.revokedAt).toBeNull();
      expect(h.revocations.revoked).toEqual(new Set([other.sessionId]));
    });

    it("answers 404 for another user's session, an unknown id and an already revoked one", async () => {
      const mine = await login();
      const otherUser = seedAccount(h, { email: 'mallory@example.com' });
      const theirs = await h.login.execute({
        email: 'mallory@example.com',
        password: PASSWORD,
        client: student,
      });
      const me = principalOf(userId, mine.sessionId);

      await expect(
        h.revokeSession.execute({ principal: me, sessionId: theirs.sessionId, client: student }),
      ).rejects.toBeInstanceOf(SessionNotFound);
      await expect(
        h.revokeSession.execute({ principal: me, sessionId: crypto.randomUUID(), client: student }),
      ).rejects.toBeInstanceOf(SessionNotFound);
      await h.revokeSession.execute({ principal: me, sessionId: mine.sessionId, client: student });
      await expect(
        h.revokeSession.execute({ principal: me, sessionId: mine.sessionId, client: student }),
      ).rejects.toBeInstanceOf(SessionNotFound);
      expect(h.sessions.sessions.get(theirs.sessionId)?.revokedAt).toBeNull();
      expect(otherUser).toBeDefined();
    });
  });

  describe('ListMySessionsQuery', () => {
    it('lists active sessions, newest use first, with device and current flag', async () => {
      const first = await login();
      h.clock.advance(1_000);
      const second = await login(clientOf('instructor', '2001:db8::1'));
      h.clock.advance(1_000);
      const revoked = await login();
      await h.logout.execute({ refreshToken: revoked.refreshToken, client: student });

      const views = await h.listSessions.execute(principalOf(userId, first.sessionId));

      expect(views).toEqual([
        {
          id: second.sessionId,
          app: 'instructor',
          device: 'Firefox on Linux',
          ip: '2001:db8::1',
          createdAt: expect.any(Date),
          lastUsedAt: expect.any(Date),
          current: false,
        },
        expect.objectContaining({ id: first.sessionId, app: 'student', current: true }),
      ]);
    });

    it('omits idle-expired sessions', async () => {
      const s = await login();
      h.clock.advance(15 * 24 * 3600_000);
      expect(await h.listSessions.execute(principalOf(userId, s.sessionId))).toEqual([]);
    });
  });
});
