import { describe, expect, it } from 'vitest';
import { AlreadyBanned, CannotBanSelf, NotBanned } from '../../../identity';
import { TargetIsAdmin, UserNotFound } from '../../domain/users.errors';
import { createUsersHarness } from '../testing/users.harness';
import { BOOTSTRAP_GRANT_REASON } from './bootstrap-admin.command';

const BAN_REASON = 'Repeated spam in Q&A';

describe('AdminSearchUsers', () => {
  it('attaches the roles of the page in one batch call', async () => {
    const h = createUsersHarness();
    const a = h.identity.add({ displayName: 'Alice' });
    const b = h.identity.add({ displayName: 'Bob' });
    h.access.give(a.id, 'INSTRUCTOR');

    const page = await h.searchUsers.execute({ limit: 20 });

    expect(page.items.map((u) => [u.displayName, u.roles])).toEqual([
      ['Bob', ['STUDENT']],
      ['Alice', ['STUDENT', 'INSTRUCTOR']],
    ]);
    expect(page.items[0]).toMatchObject({ id: b.id, status: 'ACTIVE', emailVerified: true });
    expect(typeof page.items[0]?.createdAt).toBe('string');
    expect(h.access.calls.filter((c) => c === 'getRolesForUsers')).toHaveLength(1);
    expect(h.access.calls).not.toContain('listUserIdsWithRole');
  });

  it('resolves a role filter to idIn through access', async () => {
    const h = createUsersHarness();
    const instructor = h.identity.add();
    h.identity.add();
    h.access.give(instructor.id, 'INSTRUCTOR');

    const page = await h.searchUsers.execute({ role: 'INSTRUCTOR', limit: 20 });
    expect(page.items.map((u) => u.id)).toEqual([instructor.id]);

    const none = await h.searchUsers.execute({ role: 'ADMIN', limit: 20 });
    expect(none.items).toEqual([]);
  });
});

describe('AdminGetUser', () => {
  it('returns summary, roles, ban history and the active session count', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const user = h.identity.add({ sessions: 3 });
    await h.ban.execute({ actorId: admin.id, userId: user.id, reason: BAN_REASON });
    await h.unban.execute({ actorId: admin.id, userId: user.id });
    h.identity.accounts.get(user.id)!.sessions = 1;

    const detail = await h.getUser.execute(user.id);
    expect(detail).toMatchObject({
      user: { id: user.id, status: 'ACTIVE' },
      roles: ['STUDENT'],
      activeSessionCount: 1,
    });
    expect(detail.bans).toHaveLength(1);
    expect(detail.bans[0]).toMatchObject({ reason: BAN_REASON, liftedBy: admin.id });
    expect(typeof detail.bans[0]?.liftedAt).toBe('string');
  });

  it('is 404 for an unknown user', async () => {
    const h = createUsersHarness();
    await expect(h.getUser.execute(crypto.randomUUID())).rejects.toThrow(UserNotFound);
  });
});

describe('BanUser', () => {
  it('locks the target, checks the ADMIN role under the lock, then delegates to identity', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const user = h.identity.add({ sessions: 2 });

    const ban = await h.ban.execute({ actorId: admin.id, userId: user.id, reason: BAN_REASON });

    expect(ban).toMatchObject({ userId: user.id, bannedBy: admin.id, liftedAt: null });
    expect(h.lock.locked).toEqual([user.id]);
    expect(h.access.calls).toEqual(['hasRole:ADMIN']);
    expect(h.identity.calls).toEqual(['banUser']);
    expect(h.tx.runs).toBe(1);
  });

  it('refuses to ban oneself (409 cannot_ban_self) without opening a transaction', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    await expect(
      h.ban.execute({ actorId: admin.id, userId: admin.id, reason: BAN_REASON }),
    ).rejects.toThrow(CannotBanSelf);
    expect(h.tx.runs).toBe(0);
  });

  it('refuses to ban an ADMIN (409 target_is_admin)', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const otherAdmin = h.identity.add();
    h.access.give(otherAdmin.id, 'ADMIN');
    await expect(
      h.ban.execute({ actorId: admin.id, userId: otherAdmin.id, reason: BAN_REASON }),
    ).rejects.toThrow(TargetIsAdmin);
    expect(h.identity.calls).not.toContain('banUser');
  });

  it('is 404 for an unknown user and 409 already_banned the second time', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    await expect(
      h.ban.execute({ actorId: admin.id, userId: crypto.randomUUID(), reason: BAN_REASON }),
    ).rejects.toThrow(UserNotFound);

    const user = h.identity.add();
    await h.ban.execute({ actorId: admin.id, userId: user.id, reason: BAN_REASON });
    await expect(
      h.ban.execute({ actorId: admin.id, userId: user.id, reason: BAN_REASON }),
    ).rejects.toThrow(AlreadyBanned);
  });
});

describe('UnbanUser', () => {
  it('returns the lifted ban, and 409 not_banned when there is none', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const user = h.identity.add();
    await h.ban.execute({ actorId: admin.id, userId: user.id, reason: BAN_REASON });

    const lifted = await h.unban.execute({
      actorId: admin.id,
      userId: user.id,
      reason: 'Appeal ok',
    });
    expect(lifted).toMatchObject({ liftedBy: admin.id, liftReason: 'Appeal ok' });

    await expect(h.unban.execute({ actorId: admin.id, userId: user.id })).rejects.toThrow(
      NotBanned,
    );
  });
});

describe('BootstrapAdmin', () => {
  const input = { email: 'root@example.test', displayName: 'Root', password: 'a long passphrase' };

  it('provisions a verified account and grants ADMIN from the CLI (null actor)', async () => {
    const h = createUsersHarness();

    const result = await h.bootstrapAdmin.execute(input);

    expect(result).toEqual({ userId: expect.any(String), created: true, granted: true });
    expect(h.identity.accounts.get(result.userId)?.emailVerified).toBe(true);
    expect(h.access.grants).toEqual([
      {
        userId: result.userId,
        role: 'ADMIN',
        actorId: null,
        reason: BOOTSTRAP_GRANT_REASON,
        source: { type: 'cli_bootstrap' },
      },
    ]);
    expect(h.tx.runs).toBe(1);
  });

  it('is idempotent', async () => {
    const h = createUsersHarness();
    const first = await h.bootstrapAdmin.execute(input);
    await expect(h.bootstrapAdmin.execute(input)).resolves.toEqual({
      userId: first.userId,
      created: false,
      granted: false,
    });
  });

  it('promotes an existing account without touching it', async () => {
    const h = createUsersHarness();
    const existing = h.identity.add({ email: input.email, displayName: 'Existing' });
    await expect(h.bootstrapAdmin.execute(input)).resolves.toEqual({
      userId: existing.id,
      created: false,
      granted: true,
    });
    expect(h.identity.accounts.get(existing.id)?.displayName).toBe('Existing');
  });
});
