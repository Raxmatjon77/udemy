import { describe, expect, it } from 'vitest';
import {
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUsersQuerySchema,
  BanUserRequestSchema,
  UnbanUserRequestSchema,
} from './admin-users';

/** Copy of `obj` without `key`. */
function withoutKey<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const id = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const at = '2026-10-10T12:00:00.000Z';

describe('AdminUsersQuerySchema', () => {
  it('accepts filters and treats empty values as absent', () => {
    expect(
      AdminUsersQuerySchema.parse({
        q: ' jane ',
        status: 'BANNED',
        role: 'INSTRUCTOR',
        limit: '5',
      }),
    ).toEqual({ q: 'jane', status: 'BANNED', role: 'INSTRUCTOR', limit: 5 });
    expect(
      AdminUsersQuerySchema.parse({ q: '', status: '', role: '', cursor: '', limit: '' }),
    ).toEqual({
      limit: 20,
    });
  });

  it('rejects boundary violations', () => {
    const ok = (query: unknown) => AdminUsersQuerySchema.safeParse(query).success;
    expect(ok({ q: 'ja' })).toBe(false);
    expect(ok({ q: 'j'.repeat(255) })).toBe(false);
    expect(ok({ status: 'SUSPENDED' })).toBe(false);
    expect(ok({ role: 'STUDENT' })).toBe(false);
    expect(ok({ limit: '0' })).toBe(false);
    expect(ok({ limit: 'ten' })).toBe(false);
    expect(ok({ cursor: 'not/base64url' })).toBe(false);
  });
});

describe('ban / unban bodies', () => {
  it('ban requires a 10–1000 reason', () => {
    const ok = (body: unknown) => BanUserRequestSchema.safeParse(body).success;
    expect(BanUserRequestSchema.parse({ reason: '  Spamming every course.  ' })).toEqual({
      reason: 'Spamming every course.',
    });
    expect(ok({ reason: 'r'.repeat(1000) })).toBe(true);
    expect(ok({ reason: 'r'.repeat(9) })).toBe(false);
    expect(ok({ reason: 'r'.repeat(1001) })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it('unban takes an optional 1–1000 reason', () => {
    const ok = (body: unknown) => UnbanUserRequestSchema.safeParse(body).success;
    expect(ok({})).toBe(true);
    expect(ok({ reason: 'Appeal accepted' })).toBe(true);
    expect(ok({ reason: ' ' })).toBe(false);
    expect(ok({ reason: 'r'.repeat(1001) })).toBe(false);
  });
});

describe('admin user responses', () => {
  const row = {
    id,
    email: 'jane@example.com',
    displayName: 'Jane',
    emailVerified: true,
    roles: ['STUDENT', 'ADMIN'],
    status: 'ACTIVE',
    createdAt: at,
  };
  const ban = {
    id,
    userId: id,
    reason: 'Spamming every course.',
    bannedBy: id,
    bannedAt: at,
    liftedAt: at,
    liftedBy: id,
    liftReason: null,
  };

  it('accept valid examples', () => {
    expect(AdminUserPageSchema.parse({ items: [row], nextCursor: 'eyJ9' })).toEqual({
      items: [row],
      nextCursor: 'eyJ9',
    });
    const user = withoutKey(row, 'roles');
    expect(
      AdminUserDetailSchema.safeParse({
        user,
        roles: row.roles,
        bans: [ban],
        activeSessionCount: 0,
      }).success,
    ).toBe(true);
  });

  it('reject invalid examples', () => {
    expect(AdminUserPageSchema.safeParse({ items: [row] }).success).toBe(false);
    const user = withoutKey(row, 'roles');
    expect(
      AdminUserDetailSchema.safeParse({ user, roles: [], bans: [], activeSessionCount: -1 })
        .success,
    ).toBe(false);
  });
});
