import { describe, expect, it } from 'vitest';
import { isSafeNextPath, safeNextPath } from './safe-next';

describe('safe next param', () => {
  it.each([
    '/',
    '/account',
    '/account/profile?tab=security',
    '/courses/react-101#reviews',
    '/search?q=a%2Fb',
    '/a/b/../c',
    '/%E2%9C%93',
    '/login?next=%2Faccount',
  ])('accepts %j', (value) => {
    expect(isSafeNextPath(value)).toBe(true);
    expect(safeNextPath(value, '/')).toBe(value);
  });

  it.each([
    ['empty', ''],
    ['no leading slash', 'account'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/account'],
    ['slash backslash', '/\\evil.com'],
    ['backslash anywhere', '/account\\..\\evil'],
    ['leading backslash', '\\\\evil.com'],
    ['absolute https', 'https://evil.com'],
    ['absolute http', 'http://evil.com/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,hi'],
    ['scheme-relative triple slash', '///evil.com'],
    ['tab between slashes', '/\t/evil.com'],
    ['newline between slashes', '/\n/evil.com'],
    ['carriage return', '/account\r\nSet-Cookie: x=1'],
    ['NUL', '/account\u0000'],
    ['DEL', '/account\u007f'],
    ['C1 control', '/account\u0085'],
    ['line separator', '/account '],
    ['zero-width space', '/​/evil.com'],
    ['leading space', ' /account'],
    ['encoded double slash', '/%2F%2Fevil.com'],
    ['encoded slash then slash', '/%2F/evil.com'],
    ['encoded backslash', '/%5Cevil.com'],
    ['encoded tab', '/%09/evil.com'],
    ['encoded newline', '/account%0d%0aSet-Cookie:x'],
    ['malformed percent-encoding', '/account%E0%A4%A'],
    ['too long', `/${'a'.repeat(2048)}`],
  ])('rejects %s', (_label, value) => {
    expect(isSafeNextPath(value)).toBe(false);
    expect(safeNextPath(value, '/')).toBe('/');
    expect(safeNextPath(value)).toBeNull();
  });

  it.each([undefined, null, 42, ['/account'], { path: '/' }])('rejects non-string %j', (value) => {
    expect(isSafeNextPath(value)).toBe(false);
  });
});
