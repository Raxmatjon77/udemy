import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cookieHeader,
  isoIn,
  json,
  mintAccessToken,
  ORIGIN,
  parseSetCookies,
  problem,
  stubApi,
  testConfig,
} from './internal/test-helpers';
import { createAuthProxy, RECOMMENDED_PROXY_MATCHER } from './proxy';

const AT = '__Host-udemy-student-at';
const RT = '__Host-udemy-student-rt';
const proxy = createAuthProxy(testConfig());

afterEach(() => vi.unstubAllGlobals());

function nav(path: string, cookies: Record<string, string | undefined> = {}) {
  const headers = new Headers({ 'user-agent': 'UA' });
  const cookie = cookieHeader({ theme: 'dark', ...cookies });
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(`${ORIGIN}${path}`, { headers });
}

const isNext = (res: Response) => res.headers.get('x-middleware-next') === '1';
const location = (res: Response) => {
  const value = res.headers.get('location');
  return value ? new URL(value).pathname + new URL(value).search : null;
};
/** The rewritten request Cookie header that the RSC render will see. */
const requestCookie = (res: Response) => res.headers.get('x-middleware-request-cookie');

describe('createAuthProxy redirect matrix', () => {
  it('public auth page with a valid session redirects to home', async () => {
    await stubApi({});
    const res = await proxy(nav('/login', { [AT]: await mintAccessToken(), [RT]: 'rt' }));
    expect(res.status).toBe(307);
    expect(location(res)).toBe('/');
  });

  it.each(['/signup', '/forgot-password'])(
    '%s with a session also redirects home',
    async (path) => {
      await stubApi({});
      const res = await proxy(nav(path, { [AT]: await mintAccessToken() }));
      expect(location(res)).toBe('/');
    },
  );

  it('public auth page without a session renders, without calling anything', async () => {
    const api = await stubApi({});
    const res = await proxy(nav('/login'));
    expect(isNext(res)).toBe(true);
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/verify-email', '/reset-password'])(
    '%s always renders (even signed in) with Referrer-Policy: no-referrer',
    async (path) => {
      await stubApi({});
      const res = await proxy(nav(path, { [AT]: await mintAccessToken() }));
      expect(isNext(res)).toBe(true);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    },
  );

  it('protected page without a session redirects to login with a safe next', async () => {
    await stubApi({});
    const res = await proxy(nav('/account/profile?tab=security'));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(
      `/login?next=${encodeURIComponent('/account/profile?tab=security')}`,
    );
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('protected page with a valid session continues untouched', async () => {
    const api = await stubApi({});
    const res = await proxy(nav('/account', { [AT]: await mintAccessToken(), [RT]: 'rt' }));
    expect(isNext(res)).toBe(true);
    expect(requestCookie(res)).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('expired at + valid rt: refreshes inline, rewrites the REQUEST cookie and sets cookies', async () => {
    const expired = await mintAccessToken({ expiresIn: -60 });
    const fresh = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({
          accessToken: fresh,
          accessTokenExpiresAt: isoIn(900),
          refreshToken: 'rt-2',
          refreshTokenExpiresAt: isoIn(86_400),
        }),
    });
    const res = await proxy(nav('/account', { [AT]: expired, [RT]: 'rt-1' }));

    expect(isNext(res)).toBe(true);
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
    expect(await api.calls[0]!.json()).toEqual({ refreshToken: 'rt-1' });
    const rewritten = requestCookie(res)!;
    expect(rewritten).toContain(`${AT}=${fresh}`);
    expect(rewritten).toContain(`${RT}=rt-2`);
    expect(rewritten).toContain('theme=dark');
    expect(rewritten).not.toContain(expired);
    const cookies = parseSetCookies(res.headers);
    expect(cookies.get(AT)!.value).toBe(fresh);
    expect(cookies.get(RT)!.value).toBe('rt-2');
  });

  it('expiring at (< 30 s) is refreshed too; grace path keeps the old rt in request and browser', async () => {
    const fresh = await mintAccessToken();
    await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({ accessToken: fresh, accessTokenExpiresAt: isoIn(900) }),
    });
    const res = await proxy(
      nav('/account', { [AT]: await mintAccessToken({ expiresIn: 10 }), [RT]: 'rt-1' }),
    );
    expect(isNext(res)).toBe(true);
    expect(requestCookie(res)).toContain(`${RT}=rt-1`);
    expect(requestCookie(res)).toContain(`${AT}=${fresh}`);
    expect(parseSetCookies(res.headers).has(RT)).toBe(false);
  });

  it('refresh rejected: clears cookies and redirects to login', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token') });
    const res = await proxy(nav('/account', { [RT]: 'rt-bad' }));
    expect(location(res)).toBe('/login?next=%2Faccount');
    const cookies = parseSetCookies(res.headers);
    expect(cookies.get(AT)!.attrs.get('max-age')).toBe('0');
    expect(cookies.get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it('API unreachable during refresh: redirects to login but keeps the cookies', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(503, 'service_unavailable') });
    const res = await proxy(nav('/account', { [RT]: 'rt-1' }));
    expect(location(res)).toBe('/login?next=%2Faccount');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('wrong role redirects to forbiddenRedirect', async () => {
    await stubApi({});
    const instructor = createAuthProxy(
      testConfig({
        app: 'instructor',
        requiredRole: 'INSTRUCTOR',
        publicPaths: [],
        forbiddenRedirect: '/not-instructor',
      }),
    );
    const at = await mintAccessToken({ app: 'instructor', roles: ['STUDENT'] });
    const res = await instructor(nav('/', { '__Host-udemy-instructor-at': at }));
    expect(location(res)).toBe('/not-instructor');
  });

  it('wrong role on the forbidden page itself renders (no loop)', async () => {
    await stubApi({});
    const instructor = createAuthProxy(
      testConfig({
        app: 'instructor',
        requiredRole: 'INSTRUCTOR',
        publicPaths: [],
        forbiddenRedirect: '/not-instructor',
      }),
    );
    const at = await mintAccessToken({ app: 'instructor', roles: ['STUDENT'] });
    const res = await instructor(nav('/not-instructor', { '__Host-udemy-instructor-at': at }));
    expect(isNext(res)).toBe(true);
  });

  it('admin forbiddenRedirect with a query (/login?error=forbidden) and no home loop', async () => {
    await stubApi({});
    const admin = createAuthProxy(
      testConfig({
        app: 'admin',
        requiredRole: 'ADMIN',
        sameSite: 'strict',
        forbiddenRedirect: '/login?error=forbidden',
      }),
    );
    const at = await mintAccessToken({ app: 'admin', roles: ['STUDENT'] });
    const res = await admin(nav('/users', { '__Host-udemy-admin-at': at }));
    expect(location(res)).toBe('/login?error=forbidden');
    // The login page must then render instead of bouncing the role-less session home.
    const login = await admin(nav('/login?error=forbidden', { '__Host-udemy-admin-at': at }));
    expect(isNext(login)).toBe(true);
  });

  it('wrong app claim: clears cookies and redirects to login', async () => {
    const api = await stubApi({});
    const at = await mintAccessToken({ app: 'admin', roles: ['STUDENT', 'ADMIN'] });
    const res = await proxy(nav('/account', { [AT]: at, [RT]: 'rt' }));
    expect(location(res)).toBe('/login?next=%2Faccount');
    expect(parseSetCookies(res.headers).get(AT)!.attrs.get('max-age')).toBe('0');
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(0);
  });

  it('token with a wrong issuer is invalid; refreshes with the rt', async () => {
    const fresh = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({
          accessToken: fresh,
          accessTokenExpiresAt: isoIn(900),
          refreshToken: 'r2',
          refreshTokenExpiresAt: isoIn(60),
        }),
    });
    const res = await proxy(
      nav('/account', { [AT]: await mintAccessToken({ issuer: 'http://evil' }), [RT]: 'rt' }),
    );
    expect(isNext(res)).toBe(true);
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('public page with a stale session refreshes opportunistically and never redirects', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token') });
    const res = await proxy(nav('/courses/react', { [RT]: 'rt-bad' }));
    expect(isNext(res)).toBe(true);
    expect(parseSetCookies(res.headers).get(RT)!.attrs.get('max-age')).toBe('0');
    expect(requestCookie(res)).toBe('theme=dark');
  });

  it('does not open-redirect through the next param', async () => {
    await stubApi({});
    const res = await proxy(nav('//evil.com/account'));
    const loc = res.headers.get('location');
    if (loc) expect(new URL(loc).origin).toBe(ORIGIN);
  });

  it('passes /api/* through untouched', async () => {
    const api = await stubApi({});
    const res = await proxy(nav('/api/proxy/me', { [RT]: 'rt' }));
    expect(isNext(res)).toBe(true);
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
});

describe('recommended matcher', () => {
  const regex = new RegExp(`^${RECOMMENDED_PROXY_MATCHER}$`);
  it.each(['/', '/account', '/login', '/courses/react-101'])('matches %s', (path) => {
    expect(regex.test(path)).toBe(true);
  });
  it.each([
    '/_next/static/chunk.js',
    '/_next/image',
    '/api/health',
    '/api/proxy/me',
    '/favicon.ico',
    '/logo.png',
    '/robots.txt',
  ])('excludes %s', (path) => {
    expect(regex.test(path)).toBe(false);
  });
});
