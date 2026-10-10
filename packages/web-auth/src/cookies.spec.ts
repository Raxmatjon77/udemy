import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_COOKIE_MAX_AGE_S,
  clearSetCookies,
  cookieNames,
  readCookie,
  rewriteCookieHeader,
  sessionSetCookies,
} from './cookies';
import { defineWebAuthConfig, lazyWebAuthConfig } from './config';
import { isoIn, parseSetCookies, testConfig, testInput } from './internal/test-helpers';

afterEach(() => vi.unstubAllEnvs());

describe('cookie names', () => {
  it('uses __Host- per-app names when secure', () => {
    expect(cookieNames(testConfig())).toEqual({
      refresh: '__Host-udemy-student-rt',
      access: '__Host-udemy-student-at',
    });
    expect(cookieNames(testConfig({ app: 'admin', requiredRole: 'ADMIN' })).access).toBe(
      '__Host-udemy-admin-at',
    );
  });

  it('drops the __Host- prefix when cookieSecure is false (dev)', () => {
    expect(cookieNames(testConfig({ cookieSecure: false }))).toEqual({
      refresh: 'udemy-student-rt',
      access: 'udemy-student-at',
    });
  });
});

describe('cookie attributes', () => {
  it('sets HttpOnly, Secure, Path=/, SameSite and Max-Age (rt = expiresAt - now, at = 870)', () => {
    const now = Date.now();
    const cookies = parseSetCookies(
      headersOf(
        sessionSetCookies(
          testConfig(),
          {
            accessToken: 'a.b.c',
            refreshToken: 'rt_value',
            refreshTokenExpiresAt: new Date(now + 14 * 86_400_000).toISOString(),
          },
          now,
        ),
      ),
    );
    const at = cookies.get('__Host-udemy-student-at')!;
    const rt = cookies.get('__Host-udemy-student-rt')!;
    expect(at.value).toBe('a.b.c');
    expect(rt.value).toBe('rt_value');
    for (const cookie of [at, rt]) {
      expect(cookie.attrs.get('httponly')).toBe(true);
      expect(cookie.attrs.get('secure')).toBe(true);
      expect(cookie.attrs.get('path')).toBe('/');
      expect(cookie.attrs.get('samesite')).toBe('Lax');
      expect(cookie.attrs.has('domain')).toBe(false); // __Host- forbids Domain
    }
    expect(at.attrs.get('max-age')).toBe(String(ACCESS_COOKIE_MAX_AGE_S));
    expect(rt.attrs.get('max-age')).toBe(String(14 * 86_400));
  });

  it('uses SameSite=Strict for strict apps (admin)', () => {
    const cookies = parseSetCookies(
      headersOf(
        sessionSetCookies(testConfig({ app: 'admin', requiredRole: 'ADMIN', sameSite: 'strict' }), {
          accessToken: 'x',
          refreshToken: 'y',
          refreshTokenExpiresAt: isoIn(3600),
        }),
      ),
    );
    for (const cookie of cookies.values()) expect(cookie.attrs.get('samesite')).toBe('Strict');
  });

  it('omits Secure when cookieSecure is false', () => {
    const cookies = parseSetCookies(
      headersOf(sessionSetCookies(testConfig({ cookieSecure: false }), { accessToken: 'x' })),
    );
    expect(cookies.get('udemy-student-at')!.attrs.has('secure')).toBe(false);
  });

  it('does not touch the rt cookie when there is no new refresh token (grace path)', () => {
    const cookies = parseSetCookies(
      headersOf(sessionSetCookies(testConfig(), { accessToken: 'x' })),
    );
    expect([...cookies.keys()]).toEqual(['__Host-udemy-student-at']);
  });

  it('never yields a negative Max-Age', () => {
    const cookies = parseSetCookies(
      headersOf(
        sessionSetCookies(testConfig(), {
          accessToken: 'x',
          refreshToken: 'y',
          refreshTokenExpiresAt: isoIn(-60),
        }),
      ),
    );
    expect(cookies.get('__Host-udemy-student-rt')!.attrs.get('max-age')).toBe('0');
  });

  it('clears both cookies with Max-Age=0 and the same attributes', () => {
    const cookies = parseSetCookies(headersOf(clearSetCookies(testConfig())));
    expect(cookies.size).toBe(2);
    for (const cookie of cookies.values()) {
      expect(cookie.value).toBe('');
      expect(cookie.attrs.get('max-age')).toBe('0');
      expect(cookie.attrs.get('secure')).toBe(true);
      expect(cookie.attrs.get('httponly')).toBe(true);
    }
  });

  it('refuses values that would break the header', () => {
    expect(() => sessionSetCookies(testConfig(), { accessToken: 'a;b' })).toThrow();
  });
});

describe('cookie header helpers', () => {
  it('reads one cookie', () => {
    expect(readCookie('a=1; __Host-x=two; b=3', '__Host-x')).toBe('two');
    expect(readCookie('a=1', 'b')).toBeUndefined();
    expect(readCookie(null, 'a')).toBeUndefined();
  });

  it('rewrites only the named cookies', () => {
    expect(rewriteCookieHeader('theme=dark; at=old; rt=r1', { set: { at: 'new' } })).toBe(
      'theme=dark; rt=r1; at=new',
    );
    expect(rewriteCookieHeader('theme=dark; at=old; rt=r1', { remove: ['at', 'rt'] })).toBe(
      'theme=dark',
    );
  });
});

describe('config validation', () => {
  it('refuses cookieSecure=false in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => testConfig({ cookieSecure: false })).toThrow(/production/);
    expect(() => testConfig({ cookieSecure: 'false' })).toThrow(/production/);
    expect(() => testConfig({ cookieSecure: 'true' })).not.toThrow();
  });

  it('rejects an API URL that already has /api/v1, and an origin with a path', () => {
    expect(() => testConfig({ apiInternalUrl: 'http://api:4000/api/v1' })).toThrow(/api\/v1/);
    expect(() => testConfig({ appOrigin: 'https://app.test/x' })).toThrow(/APP_ORIGIN/);
  });

  it('normalises trailing slashes and defaults', () => {
    const config = testConfig({ apiInternalUrl: 'http://api:4000/', appOrigin: 'https://a.test/' });
    expect(config.apiInternalUrl).toBe('http://api:4000');
    expect(config.appOrigin).toBe('https://a.test');
    expect(config.loginPath).toBe('/login');
    expect(config.cookiePrefix).toBe('udemy-student');
  });

  it('defaults forbiddenRedirect to loginPath?error=forbidden', () => {
    const input = testInput();
    delete input.forbiddenRedirect;
    expect(defineWebAuthConfig(input).forbiddenRedirect).toBe('/login?error=forbidden');
    expect(defineWebAuthConfig({ ...input, loginPath: '/sign-in' }).forbiddenRedirect).toBe(
      '/sign-in?error=forbidden',
    );
    expect(testConfig({ forbiddenRedirect: '/not-instructor' }).forbiddenRedirect).toBe(
      '/not-instructor',
    );
  });

  it('lazyWebAuthConfig: validates a plain config now, a thunk on first use (cached)', () => {
    expect(() => lazyWebAuthConfig(testInput({ appOrigin: 'nope' }))).toThrow(/Invalid/);
    const thunk = vi.fn(() => testInput());
    const get = lazyWebAuthConfig(thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(get()).toBe(get());
    expect(thunk).toHaveBeenCalledTimes(1);
    // An already validated config is accepted as is.
    const validated = testConfig();
    expect(lazyWebAuthConfig(() => validated)()).toBe(validated);
  });

  it('rejects unsafe redirect paths', () => {
    expect(() => testConfig({ forbiddenRedirect: '//evil.com' })).toThrow();
    expect(() => testConfig({ loginPath: 'https://evil.com/login' })).toThrow();
  });
});

function headersOf(setCookies: string[]): Headers {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return headers;
}
