import { describe, expect, it } from 'vitest';
import { Profile } from './profile';
import { InvalidUsersField } from './users.errors';

describe('Profile', () => {
  it('has null defaults until the first update', () => {
    expect(Profile.defaults('u1')).toEqual({
      userId: 'u1',
      headline: null,
      bio: null,
      avatarMediaId: null,
    });
  });

  it('keeps absent fields absent, trims set values and clears with null or blank', () => {
    expect(Profile.parseChanges({})).toEqual({});
    expect(Profile.parseChanges({ headline: '  Teacher  ' })).toEqual({ headline: 'Teacher' });
    expect(Profile.parseChanges({ headline: null, bio: '   ' })).toEqual({
      headline: null,
      bio: null,
    });
  });

  it('allows line breaks in the bio only', () => {
    expect(Profile.parseChanges({ bio: 'line 1\nline 2' })).toEqual({ bio: 'line 1\nline 2' });
    expect(() => Profile.parseChanges({ headline: 'a\nb' })).toThrow(InvalidUsersField);
  });

  it('enforces headline ≤ 60 and bio ≤ 4000 characters', () => {
    expect(Profile.parseChanges({ headline: 'h'.repeat(60) }).headline).toHaveLength(60);
    expect(() => Profile.parseChanges({ headline: 'h'.repeat(61) })).toThrow(InvalidUsersField);
    expect(Profile.parseChanges({ bio: 'b'.repeat(4000) }).bio).toHaveLength(4000);
    expect(() => Profile.parseChanges({ bio: 'b'.repeat(4001) })).toThrow(InvalidUsersField);
  });

  it('knows whether there is anything to write', () => {
    expect(Profile.hasChanges({})).toBe(false);
    expect(Profile.hasChanges({ bio: null })).toBe(true);
  });
});
