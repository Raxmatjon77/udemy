import { describe, expect, it } from 'vitest';
import { InvalidUsersField, UserNotFound } from '../../domain/users.errors';
import { createUsersHarness, principalOf } from '../testing/users.harness';

describe('GetMe', () => {
  it('returns the account, current roles, the token permissions and profile defaults', async () => {
    const h = createUsersHarness();
    const me = h.identity.add({ displayName: 'Jane', email: 'jane@example.test' });
    h.access.give(me.id, 'INSTRUCTOR');

    const result = await h.getMe.execute(
      principalOf(me.id, {
        app: 'student',
        permissions: ['profile:update:own', 'profile:read:own'],
      }),
    );

    expect(result).toEqual({
      id: me.id,
      email: 'jane@example.test',
      displayName: 'Jane',
      emailVerified: true,
      roles: ['STUDENT', 'INSTRUCTOR'],
      permissions: ['profile:read:own', 'profile:update:own'],
      app: 'student',
      profile: { headline: null, bio: null, avatarUrl: null },
    });
  });

  it('is 404 when the account vanished', async () => {
    const h = createUsersHarness();
    await expect(h.getMe.execute(principalOf(crypto.randomUUID()))).rejects.toThrow(UserNotFound);
  });
});

describe('GetMyProfile / UpdateMyProfile', () => {
  it('returns defaults until the first PATCH', async () => {
    const h = createUsersHarness();
    const me = h.identity.add({ displayName: 'Jane' });
    await expect(h.getMyProfile.execute(me.id)).resolves.toEqual({
      userId: me.id,
      displayName: 'Jane',
      headline: null,
      bio: null,
      avatarUrl: null,
    });
    expect(h.profiles.rows.size).toBe(0);
  });

  it('changes the display name through identity and upserts the profile in ONE transaction', async () => {
    const h = createUsersHarness();
    const me = h.identity.add({ displayName: 'Jane' });

    const profile = await h.updateMyProfile.execute({
      userId: me.id,
      displayName: 'Jane Doe',
      headline: 'Teacher',
      bio: 'Hello\nworld',
    });

    expect(profile).toEqual({
      userId: me.id,
      displayName: 'Jane Doe',
      headline: 'Teacher',
      bio: 'Hello\nworld',
      avatarUrl: null,
    });
    expect(h.identity.calls).toContain('changeDisplayName');
    expect(h.tx.runs).toBe(1);
  });

  it('updates only the given fields and clears with null', async () => {
    const h = createUsersHarness();
    const me = h.identity.add({ displayName: 'Jane' });
    await h.updateMyProfile.execute({ userId: me.id, headline: 'Teacher', bio: 'Bio' });

    const profile = await h.updateMyProfile.execute({ userId: me.id, headline: null });
    expect(profile).toMatchObject({ headline: null, bio: 'Bio', displayName: 'Jane' });
    expect(h.identity.calls).not.toContain('changeDisplayName');
  });

  it('a display-name-only update creates no profile row', async () => {
    const h = createUsersHarness();
    const me = h.identity.add();
    await expect(
      h.updateMyProfile.execute({ userId: me.id, displayName: 'New Name' }),
    ).resolves.toMatchObject({ displayName: 'New Name', headline: null });
    expect(h.profiles.rows.size).toBe(0);
  });

  it('rejects an empty update and invalid fields (422) before opening a transaction', async () => {
    const h = createUsersHarness();
    const me = h.identity.add();
    await expect(h.updateMyProfile.execute({ userId: me.id })).rejects.toThrow(InvalidUsersField);
    await expect(
      h.updateMyProfile.execute({ userId: me.id, headline: 'h'.repeat(61) }),
    ).rejects.toThrow(InvalidUsersField);
    expect(h.tx.runs).toBe(0);
  });
});

describe('GetPublicProfile / UsersFacade', () => {
  it('shows the public part of a profile, with isInstructor', async () => {
    const h = createUsersHarness();
    const teacher = h.identity.add({ displayName: 'Prof' });
    h.access.give(teacher.id, 'INSTRUCTOR');
    await h.updateMyProfile.execute({ userId: teacher.id, headline: 'Math teacher' });

    await expect(h.getPublicProfile.execute(teacher.id)).resolves.toEqual({
      id: teacher.id,
      displayName: 'Prof',
      headline: 'Math teacher',
      bio: null,
      avatarUrl: null,
      isInstructor: true,
    });
  });

  it('is 404 user_not_found for unknown and for banned users', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const banned = h.identity.add();
    await h.identity.banUser({} as never, {
      userId: banned.id,
      actorId: admin.id,
      reason: 'spam spam spam',
    });

    await expect(h.getPublicProfile.execute(banned.id)).rejects.toThrow(UserNotFound);
    await expect(h.getPublicProfile.execute(crypto.randomUUID())).rejects.toThrow(UserNotFound);
    await expect(h.facade.getPublicProfile(banned.id)).resolves.toBeNull();
  });

  it('getPublicProfiles batches (one call per source) and keeps the request order', async () => {
    const h = createUsersHarness();
    const a = h.identity.add({ displayName: 'A' });
    const b = h.identity.add({ displayName: 'B' });
    const unknown = crypto.randomUUID();

    const profiles = await h.facade.getPublicProfiles([b.id, unknown, a.id, b.id]);

    expect(profiles.map((p) => p.displayName)).toEqual(['B', 'A']);
    expect(h.identity.calls.filter((c) => c === 'getUserSummaries')).toHaveLength(1);
    expect(h.access.calls.filter((c) => c === 'getRolesForUsers')).toHaveLength(1);
    expect(h.profiles.findManyCalls).toBe(1);
    await expect(h.facade.getPublicProfiles([])).resolves.toEqual([]);
  });
});
