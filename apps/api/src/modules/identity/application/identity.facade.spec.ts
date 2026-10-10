import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountNotFound,
  AlreadyBanned,
  CannotBanSelf,
  InvalidBanReason,
  InvalidSearchParameter,
  NotBanned,
} from '../domain/identity.errors';
import { clientOf, FAKE_TRX } from './testing/identity.fakes';
import {
  createIdentityHarness,
  type IdentityHarness,
  PASSWORD,
  seedAccount,
} from './testing/identity.harness';
import { decodeUserCursor, encodeUserCursor, escapeLikePattern } from './user-search';

describe('IdentityFacade', () => {
  let h: IdentityHarness;

  beforeEach(() => {
    h = createIdentityHarness();
  });

  describe('reads', () => {
    it('getUserSummary / isEmailVerified / getAccountStatus', async () => {
      const id = seedAccount(h, { email: 'jane@example.com', verified: true });
      expect(await h.facade.getUserSummary(id)).toMatchObject({
        id,
        email: 'jane@example.com',
        emailVerified: true,
        status: 'ACTIVE',
      });
      expect(await h.facade.getUserSummary(crypto.randomUUID())).toBeNull();
      expect(await h.facade.isEmailVerified(id)).toBe(true);
      expect(await h.facade.isEmailVerified(crypto.randomUUID())).toBe(false);
      expect(await h.facade.getAccountStatus(id)).toEqual({ status: 'ACTIVE' });
      const ban = h.store.ban(id);
      expect(await h.facade.getAccountStatus(id)).toEqual({ status: 'BANNED', activeBan: ban });
      await expect(h.facade.getAccountStatus(crypto.randomUUID())).rejects.toBeInstanceOf(
        AccountNotFound,
      );
    });

    it('searchUsers validates q (>= 3), limit and cursor, and escapes LIKE metacharacters', async () => {
      await expect(h.facade.searchUsers({ q: 'ab', limit: 20 })).rejects.toBeInstanceOf(
        InvalidSearchParameter,
      );
      await expect(h.facade.searchUsers({ limit: 0 })).rejects.toBeInstanceOf(
        InvalidSearchParameter,
      );
      await expect(h.facade.searchUsers({ limit: 101 })).rejects.toBeInstanceOf(
        InvalidSearchParameter,
      );
      await expect(h.facade.searchUsers({ limit: 5, cursor: 'bm9wZQ' })).rejects.toBeInstanceOf(
        InvalidSearchParameter,
      );

      await h.facade.searchUsers({ q: ' 100%_a\\b ', limit: 5 });
      expect(h.directory.lastFilter?.pattern).toBe('%100\\%\\_a\\\\b%');
      expect(escapeLikePattern('a%b_c\\')).toBe('a\\%b\\_c\\\\');
    });

    it('searchUsers pages with an opaque keyset cursor; an empty idIn matches nobody', async () => {
      for (let i = 0; i < 5; i += 1) {
        seedAccount(h, { email: `user${i}@example.com` });
        h.clock.advance(1_000);
      }
      const first = await h.facade.searchUsers({ limit: 2 });
      expect(first.items.map((u) => u.email)).toEqual(['user4@example.com', 'user3@example.com']);
      expect(first.nextCursor).not.toBeNull();
      const second = await h.facade.searchUsers({ limit: 2, cursor: first.nextCursor ?? '' });
      expect(second.items.map((u) => u.email)).toEqual(['user2@example.com', 'user1@example.com']);
      const third = await h.facade.searchUsers({ limit: 2, cursor: second.nextCursor ?? '' });
      expect(third).toMatchObject({ nextCursor: null });
      expect(third.items).toHaveLength(1);

      expect(await h.facade.searchUsers({ limit: 2, idIn: [] })).toEqual({
        items: [],
        nextCursor: null,
      });
      const keyset = { createdAt: '2026-10-10T09:00:00.123456Z', id: crypto.randomUUID() };
      expect(decodeUserCursor(encodeUserCursor(keyset))).toEqual(keyset);
    });
  });

  describe('changeDisplayName', () => {
    it('emits DisplayNameChanged only when the name changes', async () => {
      const id = seedAccount(h);
      await h.facade.changeDisplayName(FAKE_TRX, { userId: id, displayName: '  New Name ' });
      await h.facade.changeDisplayName(FAKE_TRX, { userId: id, displayName: 'New Name' });
      expect(h.events.types()).toEqual(['DisplayNameChanged']);
      expect(h.events.published[0]?.payload).toMatchObject({ userId: id, displayName: 'New Name' });
      await expect(
        h.facade.changeDisplayName(FAKE_TRX, { userId: crypto.randomUUID(), displayName: 'X' }),
      ).rejects.toBeInstanceOf(AccountNotFound);
    });
  });

  describe('revokeAllSessions / banUser / unbanUser', () => {
    it('revokeAllSessions revokes in the DB and sets every sid key', async () => {
      const id = seedAccount(h, { email: 'jane@example.com' });
      const a = await h.login.execute({
        email: 'jane@example.com',
        password: PASSWORD,
        client: clientOf('student'),
      });
      const result = await h.facade.revokeAllSessions(FAKE_TRX, {
        userId: id,
        reason: 'ROLE_LOST',
      });
      expect(result.revokedSessionIds).toEqual([a.sessionId]);
      expect(h.revocations.revoked.has(a.sessionId)).toBe(true);
      expect(h.sessions.sessions.get(a.sessionId)?.revokeReason).toBe('ROLE_LOST');
    });

    it('banUser: lock, ban, revoke sessions, UserBanned, security event, sid keys', async () => {
      const admin = seedAccount(h, { email: 'admin@example.com' });
      const id = seedAccount(h, { email: 'jane@example.com' });
      const s = await h.login.execute({
        email: 'jane@example.com',
        password: PASSWORD,
        client: clientOf('student'),
      });

      const ban = await h.facade.banUser(FAKE_TRX, {
        userId: id,
        actorId: admin,
        reason: '  Repeated spam  ',
      });

      expect(ban).toMatchObject({
        userId: id,
        bannedBy: admin,
        reason: 'Repeated spam',
        liftedAt: null,
      });
      expect(h.accounts.locks).toContainEqual({ userId: id, mode: 'update' });
      expect(h.sessions.sessions.get(s.sessionId)?.revokeReason).toBe('BANNED');
      expect(h.revocations.revoked.has(s.sessionId)).toBe(true);
      expect(h.events.types()).toEqual(['UserBanned']);
      expect(h.securityLog.events.at(-1)).toMatchObject({ type: 'USER_BANNED', userId: id });

      await expect(
        h.facade.banUser(FAKE_TRX, { userId: id, actorId: admin, reason: 'Again, more spam' }),
      ).rejects.toBeInstanceOf(AlreadyBanned);
      await expect(
        h.facade.banUser(FAKE_TRX, { userId: admin, actorId: admin, reason: 'Banning myself' }),
      ).rejects.toBeInstanceOf(CannotBanSelf);
      await expect(
        h.facade.banUser(FAKE_TRX, { userId: admin, actorId: id, reason: 'short' }),
      ).rejects.toBeInstanceOf(InvalidBanReason);
      await expect(
        h.facade.banUser(FAKE_TRX, {
          userId: crypto.randomUUID(),
          actorId: admin,
          reason: 'Unknown user here',
        }),
      ).rejects.toBeInstanceOf(AccountNotFound);
    });

    it('banUser fails (caller rolls back) when Redis cannot record the revocations', async () => {
      const admin = seedAccount(h);
      const id = seedAccount(h);
      h.revocations.down = true;
      await expect(
        h.facade.banUser(FAKE_TRX, { userId: id, actorId: admin, reason: 'Repeated spam' }),
      ).rejects.toThrow('Redis down');
    });

    it('unbanUser lifts the active ban and emits UserUnbanned; NotBanned otherwise', async () => {
      const admin = seedAccount(h);
      const id = seedAccount(h);
      h.store.ban(id, admin);
      const lifted = await h.facade.unbanUser(FAKE_TRX, {
        userId: id,
        actorId: admin,
        reason: 'Appeal accepted',
      });
      expect(lifted).toMatchObject({ userId: id, liftedBy: admin, liftReason: 'Appeal accepted' });
      expect(h.events.types()).toEqual(['UserUnbanned']);
      await expect(
        h.facade.unbanUser(FAKE_TRX, { userId: id, actorId: admin }),
      ).rejects.toBeInstanceOf(NotBanned);
    });
  });

  describe('provisionAccount', () => {
    it('creates a verified account once, then reports created: false', async () => {
      const first = await h.facade.provisionAccount(FAKE_TRX, {
        email: 'Root@Example.com',
        displayName: 'Root',
        password: PASSWORD,
        emailVerified: true,
      });
      expect(first.created).toBe(true);
      expect(await h.facade.isEmailVerified(first.userId)).toBe(true);
      expect(h.events.types()).toEqual(['UserRegistered']);

      const again = await h.facade.provisionAccount(FAKE_TRX, {
        email: 'root@example.com',
        displayName: 'Root',
        password: 'another strong passphrase',
        emailVerified: true,
      });
      expect(again).toEqual({ userId: first.userId, created: false });
    });
  });
});
