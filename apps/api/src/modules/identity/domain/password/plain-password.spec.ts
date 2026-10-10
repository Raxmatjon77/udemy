import { describe, expect, it } from 'vitest';
import { Email } from '../email';
import { WeakPassword } from '../identity.errors';
import { commonPasswordCount, isCommonPassword } from './common-passwords';
import { normalizePassword, PlainPassword } from './plain-password';

const email = Email.parse('jane.doe.smith@example.com');

function reasonOf(raw: string): string | undefined {
  try {
    PlainPassword.create(raw, { email });
    return undefined;
  } catch (error) {
    if (error instanceof WeakPassword) return error.reason;
    throw error;
  }
}

describe('PlainPassword', () => {
  it('accepts 10–128 characters with no composition rules', () => {
    expect(reasonOf('correct horse battery')).toBeUndefined();
    expect(reasonOf('a'.repeat(9) + 'b')).toBeUndefined();
    expect(reasonOf('x'.repeat(128))).toBeUndefined();
  });

  it('never trims the value', () => {
    expect(PlainPassword.create('  spaced out pw  ', { email }).value).toBe('  spaced out pw  ');
  });

  it('stores the NFKC form, so compatibility-equivalent input is the same password', () => {
    const fullwidth = 'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ';
    expect(PlainPassword.create(fullwidth, { email }).value).toBe('correct horse battery');
    // Decomposed e + combining acute -> precomposed é; the ﬁ ligature -> "fi".
    expect(PlainPassword.create('cafe\u0301 ﬁxture 42', { email }).value).toBe('café fixture 42');
    expect(normalizePassword('Ｐａｓｓ ｗｏｒｄ')).toBe('Pass word');
    // Case is preserved (NFKC does not fold case).
    expect(normalizePassword('MiXeD Case')).toBe('MiXeD Case');
  });

  it('applies the policy to the normalised value', () => {
    // Fullwidth digits are the common password "1234567890" after NFKC.
    expect(reasonOf('１２３４５６７８９０')).toBe('common');
  });

  it('enforces the length in code points', () => {
    expect(reasonOf('a'.repeat(9))).toBe('too_short');
    expect(reasonOf('x'.repeat(129))).toBe('too_long');
    // 5 emoji = 10 UTF-16 units but only 5 characters.
    expect(reasonOf('😀'.repeat(5))).toBe('too_short');
    expect(reasonOf('😀'.repeat(128))).toBeUndefined();
  });

  it('rejects the email and its local part, case-insensitively', () => {
    expect(reasonOf('jane.doe.smith@example.com')).toBe('matches_email');
    expect(reasonOf('Jane.Doe.Smith')).toBe('matches_email');
  });

  it('rejects common passwords, case-insensitively', () => {
    expect(reasonOf('1234567890')).toBe('common');
    expect(reasonOf('QwertyUiop')).toBe('common');
    expect(reasonOf('Basketball')).toBe('common');
  });

  it('ships the full bundled list, loaded once', () => {
    expect(commonPasswordCount()).toBeGreaterThanOrEqual(10_000);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('correct horse battery')).toBe(false);
  });

  it('is a 422 weak_password on the given field', () => {
    expect(() => PlainPassword.create('short', { email, field: 'newPassword' })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        code: 'weak_password',
        issues: [{ path: 'newPassword', message: expect.any(String) }],
      }),
    );
  });

  it('never prints its value', () => {
    const password = PlainPassword.create('correct horse battery', { email });
    expect(String(password)).toBe('[PlainPassword]');
    expect(JSON.stringify({ password })).toBe('{"password":"[PlainPassword]"}');
  });
});
