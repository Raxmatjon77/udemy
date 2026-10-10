import { describe, expect, it } from 'vitest';
import {
  MeResponseSchema,
  ProfileSchema,
  PublicProfileSchema,
  UpdateProfileRequestSchema,
  UserIdParamsSchema,
} from './me';

const id = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';

describe('UpdateProfileRequestSchema', () => {
  const ok = (body: unknown) => UpdateProfileRequestSchema.safeParse(body).success;

  it('accepts partial updates and trims', () => {
    expect(UpdateProfileRequestSchema.parse({ headline: ' Teacher ' })).toEqual({
      headline: 'Teacher',
    });
    expect(ok({ displayName: 'Jane', bio: 'Line one\nLine two\ttab' })).toBe(true);
    expect(ok({ headline: null, bio: null })).toBe(true);
  });

  it('requires at least one field', () => {
    expect(ok({})).toBe(false);
  });

  it('applies the length and character rules', () => {
    expect(ok({ headline: 'h'.repeat(60) })).toBe(true);
    expect(ok({ headline: 'h'.repeat(61) })).toBe(false);
    expect(ok({ headline: 'two\nlines' })).toBe(false);
    expect(ok({ headline: '  ' })).toBe(false);
    expect(ok({ bio: 'b'.repeat(4000) })).toBe(true);
    expect(ok({ bio: 'b'.repeat(4001) })).toBe(false);
    expect(ok({ bio: 'bell\u0007' })).toBe(false);
    expect(ok({ displayName: '' })).toBe(false);
    expect(ok({ displayName: null })).toBe(false);
    expect(ok({ displayName: 'd'.repeat(61) })).toBe(false);
  });
});

describe('me / profile responses', () => {
  it('accept valid examples', () => {
    const profile = { userId: id, displayName: 'Jane', headline: null, bio: null, avatarUrl: null };
    expect(ProfileSchema.parse(profile)).toEqual(profile);
    expect(
      MeResponseSchema.safeParse({
        id,
        email: 'jane@example.com',
        displayName: 'Jane',
        emailVerified: true,
        roles: ['STUDENT', 'INSTRUCTOR'],
        permissions: ['profile:read:own', 'instructor_application:create:own'],
        app: 'student',
        profile: { headline: 'Teacher', bio: null, avatarUrl: null },
      }).success,
    ).toBe(true);
    expect(
      PublicProfileSchema.safeParse({
        id,
        displayName: 'Jane',
        headline: null,
        bio: null,
        avatarUrl: null,
        isInstructor: false,
      }).success,
    ).toBe(true);
  });

  it('reject unknown permissions and apps', () => {
    const me = {
      id,
      email: 'jane@example.com',
      displayName: 'Jane',
      emailVerified: true,
      roles: ['STUDENT'],
      permissions: ['course:delete:any'],
      app: 'student',
      profile: { headline: null, bio: null, avatarUrl: null },
    };
    expect(MeResponseSchema.safeParse(me).success).toBe(false);
    expect(MeResponseSchema.safeParse({ ...me, permissions: [], app: 'mobile' }).success).toBe(
      false,
    );
  });

  it('requires a uuid user id param', () => {
    expect(UserIdParamsSchema.safeParse({ userId: id }).success).toBe(true);
    expect(UserIdParamsSchema.safeParse({ userId: 'me' }).success).toBe(false);
  });
});
