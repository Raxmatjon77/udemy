import { describe, expect, it } from 'vitest';
import { Email } from './email';
import { InvalidEmail } from './identity.errors';

describe('Email', () => {
  it('trims, NFKC-normalises and lowercases', () => {
    expect(Email.parse('  Jane.Doe@Example.COM ').value).toBe('jane.doe@example.com');
    // Fullwidth letters and the fullwidth @ fold to ASCII under NFKC.
    expect(Email.parse('ＪＡＮＥ＠example.com').value).toBe('jane@example.com');
  });

  it('keeps provider-specific variants distinct (no dot or +tag stripping)', () => {
    expect(Email.parse('j.ane+x@gmail.com').value).toBe('j.ane+x@gmail.com');
    expect(Email.parse('jane@gmail.com').equals(Email.parse('j.ane@gmail.com'))).toBe(false);
  });

  it('exposes the local part', () => {
    expect(Email.parse('jane@example.com').localPart).toBe('jane');
  });

  it('accepts 64-character local parts and 254-character addresses', () => {
    const local = 'a'.repeat(64);
    expect(Email.parse(`${local}@example.com`).localPart).toBe(local);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(Email.parse(`${local}@${domain}`).value).toHaveLength(254);
  });

  it.each([
    ['empty', ''],
    ['no @', 'jane.example.com'],
    ['empty local part', '@example.com'],
    ['empty domain', 'jane@'],
    ['no dot in the domain', 'jane@localhost'],
    ['two @', 'jane@doe@example.com'],
    ['inner whitespace', 'ja ne@example.com'],
    ['control character', 'jane\u0000@example.com'],
    ['double dot', 'ja..ne@example.com'],
    ['leading dot', '.jane@example.com'],
    ['empty domain label', 'jane@example..com'],
    ['local part over 64', `${'a'.repeat(65)}@example.com`],
    [
      'address over 254',
      `jane@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
    ],
  ])('rejects %s', (_case, raw) => {
    expect(() => Email.parse(raw)).toThrow(InvalidEmail);
  });

  it('maps to 422 validation_failed on the given field', () => {
    const error = (() => {
      try {
        Email.parse('nope', 'newEmail');
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvalidEmail);
    expect(error).toMatchObject({
      kind: 'validation',
      code: 'validation_failed',
      issues: [{ path: 'newEmail' }],
    });
  });
});
