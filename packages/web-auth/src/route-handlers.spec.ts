import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cookieHeader,
  isoIn,
  json,
  mintAccessToken,
  ORIGIN,
  parseSetCookies,
  problem,
  SESSION_ID,
  stubApi,
  testConfig,
  testInput,
  USER_ID,
} from './internal/test-helpers';
import { createAuthRouteHandlers } from './route-handlers';

const config = testConfig();
const routes = createAuthRouteHandlers(config);
const AT = '__Host-udemy-student-at';
const RT = '__Host-udemy-student-rt';

afterEach(() => vi.unstubAllGlobals());

function post(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ origin: ORIGIN, ...init.headers });
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
}

const user = {
  id: USER_ID,
  email: 'jane@example.com',
  displayName: 'Jane',
  emailVerified: true,
  roles: ['STUDENT'],
};

async function authResult() {
  return {
    accessToken: await mintAccessToken(),
    accessTokenExpiresAt: isoIn(900),
    refreshToken: 'rt-login',
    refreshTokenExpiresAt: isoIn(14 * 86_400),
    sessionId: SESSION_ID,
    user,
  };
}

describe('CSRF / Origin rules on every auth handler', () => {
  const handlers = Object.entries(routes);

  it.each(handlers)('%s rejects a missing Origin with 403', async (_name, handler) => {
    const api = await stubApi({});
    const request = new Request(`${ORIGIN}/api/auth/x`, { method: 'POST' });
    const response = await handler(request);
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(api.calls).toHaveLength(0);
  });

  it.each(handlers)('%s rejects a foreign Origin with 403', async (_name, handler) => {
    const api = await stubApi({});
    const response = await handler(
      post('/api/auth/x', {
        headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(response.status).toBe(403);
    expect(api.calls).toHaveLength(0);
  });

  it('accepts Sec-Fetch-Site: same-origin as the fallback', async () => {
    await stubApi({});
    const response = await routes.logout(
      post('/api/auth/logout', {
        headers: { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(response.status).toBe(204);
  });

  it('login requires a JSON content type', async () => {
    const api = await stubApi({});
    const response = await routes.login(
      post('/api/auth/login', {
        body: { email: 'a@b.co', password: 'x' },
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(response.status).toBe(415);
    expect(api.calls).toHaveLength(0);
  });
});

describe('login', () => {
  it('posts to /auth/login with client credentials and returns only { user } + cookies', async () => {
    const result = await authResult();
    const api = await stubApi({ 'POST /api/v1/auth/login': () => json(result) });
    const response = await routes.login(
      post('/api/auth/login', {
        body: { email: ' Jane@Example.com ', password: 'correct horse' },
        headers: { 'user-agent': 'UA/1', 'x-real-ip': '203.0.113.9' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ user });
    expect(text).not.toContain(result.accessToken);
    expect(text).not.toContain('rt-login');

    const [call] = api.calls;
    expect(call!.headers.get('x-client-id')).toBe('student-bff');
    expect(call!.headers.get('x-client-secret')).toBe('secret');
    expect(call!.headers.get('x-client-ip')).toBe('203.0.113.9');
    expect(call!.headers.get('x-client-user-agent')).toBe('UA/1');
    expect(call!.headers.has('authorization')).toBe(false);
    expect(await call!.json()).toEqual({ email: 'jane@example.com', password: 'correct horse' });

    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.value).toBe(result.accessToken);
    expect(cookies.get(RT)!.value).toBe('rt-login');
  });

  it('passes API problems through (with Retry-After) and sets no cookies', async () => {
    await stubApi({
      'POST /api/v1/auth/login': () => {
        const res = problem(429, 'too_many_attempts');
        res.headers.set('retry-after', '60');
        return res;
      },
    });
    const response = await routes.login(
      post('/api/auth/login', { body: { email: 'a@b.co', password: 'x' } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await response.json()).code).toBe('too_many_attempts');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('returns 503 when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const response = await routes.login(
      post('/api/auth/login', { body: { email: 'a@b.co', password: 'x' } }),
    );
    expect(response.status).toBe(503);
  });

  it('rejects a malformed body with 400 before calling the API', async () => {
    const api = await stubApi({});
    const response = await routes.login(post('/api/auth/login', { body: { email: 'nope' } }));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes upstream and clears both cookies with 204', async () => {
    const api = await stubApi({
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    const response = await routes.logout(
      post('/api/auth/logout', { headers: { cookie: cookieHeader({ [RT]: 'rt-1', [AT]: 'x' }) } }),
    );
    expect(response.status).toBe(204);
    expect(await api.calls[0]!.json()).toEqual({ refreshToken: 'rt-1' });
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.attrs.get('max-age')).toBe('0');
    expect(cookies.get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it('still clears the cookies and returns 204 when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const response = await routes.logout(
      post('/api/auth/logout', { headers: { cookie: cookieHeader({ [RT]: 'rt-1' }) } }),
    );
    expect(response.status).toBe(204);
    expect(parseSetCookies(response.headers).size).toBe(2);
  });
});

describe('logout-all', () => {
  it('calls /auth/logout-all with Bearer and clears cookies', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/logout-all': () => new Response(null, { status: 204 }),
    });
    const response = await routes.logoutAll(
      post('/api/auth/logout-all', { headers: { cookie: cookieHeader({ [AT]: at, [RT]: 'rt' }) } }),
    );
    expect(response.status).toBe(204);
    expect(api.calls[0]!.headers.get('authorization')).toBe(`Bearer ${at}`);
    expect(parseSetCookies(response.headers).get(AT)!.attrs.get('max-age')).toBe('0');
  });

  it('clears the cookies when the API says the session is already gone (401 unauthorized)', async () => {
    const at = await mintAccessToken();
    await stubApi({ 'POST /api/v1/auth/logout-all': () => problem(401, 'unauthorized') });
    const response = await routes.logoutAll(
      post('/api/auth/logout-all', { headers: { cookie: cookieHeader({ [AT]: at, [RT]: 'rt' }) } }),
    );
    expect(response.status).toBe(401);
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.attrs.get('max-age')).toBe('0');
    expect(cookies.get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it('clears the cookies when the refresh before it is rejected', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token') });
    const response = await routes.logoutAll(
      post('/api/auth/logout-all', { headers: { cookie: cookieHeader({ [RT]: 'rt-bad' }) } }),
    );
    expect(response.status).toBe(401);
    expect(parseSetCookies(response.headers).get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it('keeps the cookies and reports 503 when the API is down (retryable)', async () => {
    const at = await mintAccessToken();
    await stubApi({ 'POST /api/v1/auth/logout-all': () => problem(503, 'service_unavailable') });
    const response = await routes.logoutAll(
      post('/api/auth/logout-all', { headers: { cookie: cookieHeader({ [AT]: at, [RT]: 'rt' }) } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('refresh', () => {
  it('rotates: sets the new at and rt, returns no tokens', async () => {
    const at = await mintAccessToken();
    await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({
          accessToken: at,
          accessTokenExpiresAt: isoIn(900),
          refreshToken: 'rt-2',
          refreshTokenExpiresAt: isoIn(86_400),
        }),
    });
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-1' }) } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['accessTokenExpiresAt']);
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.value).toBe(at);
    expect(cookies.get(RT)!.value).toBe('rt-2');
  });

  it('grace path (no new rt): sets only the at cookie and keeps the old rt cookie', async () => {
    const at = await mintAccessToken();
    await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({ accessToken: at, accessTokenExpiresAt: isoIn(900) }),
    });
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-old' }) } }),
    );
    expect(response.status).toBe(200);
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.value).toBe(at);
    expect(cookies.has(RT)).toBe(false); // untouched: neither overwritten nor cleared
  });

  it('clears cookies and returns 401 when the refresh token is rejected', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token') });
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-bad' }) } }),
    );
    expect(response.status).toBe(401);
    expect(parseSetCookies(response.headers).get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it('keeps cookies and returns 503 when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-1' }) } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('refresh failures: ended vs transient', () => {
  it.each([
    [401, 'invalid_refresh_token'],
    [403, 'account_banned'],
    [403, 'app_access_denied'],
  ])('a %i %s ends the session: 401 + cleared cookies', async (status, code) => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(status, code) });
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-1' }) } }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('invalid_refresh_token');
    expect(parseSetCookies(response.headers).get(AT)!.attrs.get('max-age')).toBe('0');
    expect(parseSetCookies(response.headers).get(RT)!.attrs.get('max-age')).toBe('0');
  });

  it.each([
    [429, 'rate_limited'],
    [503, 'service_unavailable'],
    [500, 'internal'],
  ])('a %i %s is transient: 503, cookies kept', async (status, code) => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(status, code) });
    const response = await routes.refresh(
      post('/api/auth/refresh', { headers: { cookie: cookieHeader({ [RT]: 'rt-1' }) } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('lazy config', () => {
  it('a thunk is resolved on the first request only, then cached', async () => {
    const thunk = vi.fn(() => testInput());
    const lazy = createAuthRouteHandlers(thunk);
    expect(thunk).not.toHaveBeenCalled();
    await stubApi({ 'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }) });
    expect((await lazy.logout(post('/api/auth/logout'))).status).toBe(204);
    expect((await lazy.refresh(post('/api/auth/refresh'))).status).toBe(401);
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it('a plain invalid config still fails at creation', () => {
    expect(() => createAuthRouteHandlers(testInput({ jwksUrl: 'nope' }))).toThrow(/Invalid/);
  });
});
