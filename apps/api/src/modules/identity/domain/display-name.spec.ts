import { describe, expect, it } from 'vitest';
import { DisplayName } from './display-name';
import { InvalidDisplayName } from './identity.errors';

describe('DisplayName', () => {
  it('trims', () => {
    expect(DisplayName.parse('  Jane Doe  ').value).toBe('Jane Doe');
  });

  it('counts code points, not UTF-16 units (60 emoji are fine)', () => {
    const name = '😀'.repeat(60);
    expect(DisplayName.parse(name).value).toBe(name);
    expect(() => DisplayName.parse('😀'.repeat(61))).toThrow(InvalidDisplayName);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['61 characters', 'a'.repeat(61)],
    ['a newline', 'Jane\nDoe'],
    ['a NUL', 'Jane\u0000'],
    ['DEL', 'Jane\u007f'],
  ])('rejects %s', (_case, raw) => {
    expect(() => DisplayName.parse(raw)).toThrow(InvalidDisplayName);
  });

  it('is a 422 validation_failed', () => {
    expect(() => DisplayName.parse('')).toThrow(
      expect.objectContaining({ code: 'validation_failed', kind: 'validation' }),
    );
  });
});
