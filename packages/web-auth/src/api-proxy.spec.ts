import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiProxyHandler, parseProxyPath } from './api-proxy';
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
  testInput,
} from './internal/test-helpers';
import { inflightRefreshCount } from './refresh';

const config = testConfig();
const proxy = createApiProxyHandler(config);
const AT = '__Host-udemy-student-at';
const RT = '__Host-udemy-student-rt';

afterEach(() => vi.unstubAllGlobals());

function request(
  method: string,
  path: string,
  init: {
    body?: BodyInit | null;
    headers?: Record<string, string>;
    cookies?: Record<string, string | undefined>;
  } = {},
) {
  const headers = new Headers(init.headers);
  if (init.cookies) headers.set('cookie', cookieHeader(init.cookies));
  // Real HTTP requests carry Content-Length; Node's Request does not add it for string bodies.
  if (typeof init.body === 'string' && !headers.has('content-length')) {
    headers.set('content-length', String(new TextEncoder().encode(init.body).byteLength));
  }
  return new Request(`${ORIGIN}/api/proxy/${path}`, {
    method,
    headers,
    body: init.body ?? null,
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

const jsonPost = (path: string, body: unknown, cookies?: Record<string, string | undefined>) =>
  request('POST', path, {
    body: JSON.stringify(body),
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    ...(cookies ? { cookies } : {}),
  });

function refreshResult(at: string, rt?: string) {
  return {
    accessToken: at,
    accessTokenExpiresAt: isoIn(900),
    ...(rt ? { refreshToken: rt, refreshTokenExpiresAt: isoIn(86_400) } : {}),
  };
}

describe('denylist', () => {
  it.each(['auth/login', 'auth/refresh', 'auth/logout', 'AUTH/Login', 'auth/%6Cogin'])(
    'denies %s with 404 without calling the API',
    async (path) => {
      const api = await stubApi({});
      const response = await proxy(jsonPost(path, {}));
      expect(response.status).toBe(404);
      expect(api.calls).toHaveLength(0);
    },
  );

  // (`me/%2e%2e/x` is normalised by the URL parser to `/api/proxy/x` before the handler runs.)
  it.each(['me/..%2Fadmin', 'me/%2e%2e%2fadmin', 'me/a%2Fb', 'me//x', 'me/a%5Cb', 'me/%00'])(
    'rejects unsafe path %s with 404',
    async (path) => {
      const api = await stubApi({});
      const response = await proxy(request('GET', path));
      expect(response.status).toBe(404);
      expect(api.calls).toHaveLength(0);
    },
  );

  it('re-encodes segments', () => {
    expect(parseProxyPath('/api/proxy/users/a%20b/profile')).toBe('users/a%20b/profile');
  });

  it('allows other auth endpoints such as logout-all and signup', async () => {
    const api = await stubApi({
      'POST /api/v1/auth/signup': () => json({ status: 'accepted' }, 202),
    });
    const response = await proxy(jsonPost('auth/signup', { email: 'a@b.co' }));
    expect(response.status).toBe(202);
    expect(api.calls).toHaveLength(1);
  });
});

describe('CSRF rules', () => {
  it('403 on an unsafe method without Origin', async () => {
    const api = await stubApi({});
    const response = await proxy(
      request('POST', 'me/instructor-applications', {
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(403);
    expect(api.calls).toHaveLength(0);
  });

  it('403 on a foreign Origin', async () => {
    const api = await stubApi({});
    const response = await proxy(
      request('DELETE', 'auth/sessions/1', { headers: { origin: 'https://evil.test' } }),
    );
    expect(response.status).toBe(403);
    expect(api.calls).toHaveLength(0);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    '415 for a body with Content-Type %s',
    async (contentType) => {
      const api = await stubApi({});
      const response = await proxy(
        request('POST', 'me/instructor-applications', {
          body: '{}',
          headers: { origin: ORIGIN, 'content-type': contentType },
        }),
      );
      expect(response.status).toBe(415);
      expect(api.calls).toHaveLength(0);
    },
  );

  it('allows a bodyless unsafe request without Content-Type', async () => {
    await stubApi({ 'DELETE /api/v1/auth/sessions/1': () => new Response(null, { status: 204 }) });
    const response = await proxy(
      request('DELETE', 'auth/sessions/1', { headers: { origin: ORIGIN } }),
    );
    expect(response.status).toBe(204);
  });

  it('GET needs no Origin', async () => {
    await stubApi({ 'GET /api/v1/users/u1/profile': () => json({ id: 'u1' }) });
    expect((await proxy(request('GET', 'users/u1/profile'))).status).toBe(200);
  });

  it('413 for a declared body above the limit', async () => {
    const small = createApiProxyHandler(testConfig({ maxProxyBodyBytes: 10 }));
    const api = await stubApi({});
    const response = await small(jsonPost('me/profile', { bio: 'x'.repeat(100) }));
    expect(response.status).toBe(413);
    expect(api.calls).toHaveLength(0);
  });
});

describe('forwarding and header allowlist', () => {
  it('forwards method, path, query, body, Bearer and client headers', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/me/instructor-applications': () =>
        json({ id: 'app-1' }, 201, { location: '/api/v1/instructor-applications/app-1' }),
    });
    const req = request('POST', 'me/instructor-applications?x=1', {
      body: JSON.stringify({ motivation: 'm' }),
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.1, 203.0.113.7',
        'user-agent': 'UA/2',
        authorization: 'Bearer attacker',
        'x-client-secret': 'spoofed',
      },
      cookies: { [AT]: at, [RT]: 'rt', other: 'v' },
    });
    const response = await proxy(req);
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/api/proxy/instructor-applications/app-1');

    const call = api.calls[0]!;
    expect(new URL(call.url).href).toBe(
      'http://api.internal:4000/api/v1/me/instructor-applications?x=1',
    );
    expect(call.headers.get('authorization')).toBe(`Bearer ${at}`);
    expect(call.headers.get('x-client-secret')).toBe('secret');
    expect(call.headers.get('x-client-ip')).toBe('203.0.113.7');
    expect(call.headers.get('x-client-user-agent')).toBe('UA/2');
    expect(call.headers.has('cookie')).toBe(false);
    expect(await call.json()).toEqual({ motivation: 'm' });
  });

  it('strips set-cookie and non-allowlisted response headers', async () => {
    const at = await mintAccessToken();
    await stubApi({
      'GET /api/v1/me': () =>
        new Response('{"id":"u"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'evil=1; Path=/',
            'x-powered-by': 'Express',
            server: 'nest',
            'x-internal-debug': 'secret',
            etag: '"v1"',
            'x-request-id': 'req-1',
            'cache-control': 'private, max-age=0',
          },
        }),
    });
    const response = await proxy(request('GET', 'me', { cookies: { [AT]: at } }));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(response.headers.get('x-internal-debug')).toBeNull();
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0');
    expect(await response.json()).toEqual({ id: 'u' });
  });

  it('drops a Location that points outside the API prefix', async () => {
    await stubApi({
      'GET /api/v1/x': () =>
        new Response(null, { status: 302, headers: { location: 'http://internal/admin' } }),
    });
    const response = await proxy(request('GET', 'x'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('streams a large body upstream', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({
      'PUT /api/v1/me/blob': async (req) => json({ size: (await req.text()).length }),
    });
    const big = JSON.stringify({ data: 'x'.repeat(200_000) });
    const stream = new Blob([big]).stream();
    const response = await proxy(
      request('PUT', 'me/blob', {
        body: stream,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        cookies: { [AT]: at },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).size).toBe(big.length);
    expect(api.calls).toHaveLength(1);
  });
});

describe('refresh in the proxy', () => {
  it('single-flight: N concurrent requests with an expiring at produce exactly 1 refresh', async () => {
    const expiring = await mintAccessToken({ expiresIn: 10 });
    const fresh = await mintAccessToken();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = await stubApi({
      'POST /api/v1/auth/refresh': async () => {
        await gate;
        return json(refreshResult(fresh, 'rt-2'));
      },
      'GET /api/v1/me': () => json({ ok: true }),
    });

    const N = 10;
    const pending = Array.from({ length: N }, () =>
      proxy(request('GET', 'me', { cookies: { [AT]: expiring, [RT]: 'rt-1' } })),
    );
    await vi.waitFor(() => expect(inflightRefreshCount()).toBe(1));
    release();
    const responses = await Promise.all(pending);

    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
    const meCalls = api.callsTo('GET', '/api/v1/me');
    expect(meCalls).toHaveLength(N);
    for (const call of meCalls) expect(call.headers.get('authorization')).toBe(`Bearer ${fresh}`);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(parseSetCookies(response.headers).get(RT)!.value).toBe('rt-2');
    }
    expect(inflightRefreshCount()).toBe(0);
  });

  it('refreshes first when there is no at but an rt', async () => {
    const fresh = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh, 'rt-2')),
      'GET /api/v1/me': () => json({}),
    });
    const response = await proxy(request('GET', 'me', { cookies: { [RT]: 'rt-1' } }));
    expect(response.status).toBe(200);
    expect(api.callsTo('GET', '/api/v1/me')[0]!.headers.get('authorization')).toBe(
      `Bearer ${fresh}`,
    );
  });

  it('does not refresh when the at has more than 30 s left', async () => {
    const at = await mintAccessToken({ expiresIn: 120 });
    const api = await stubApi({ 'GET /api/v1/me': () => json({}) });
    await proxy(request('GET', 'me', { cookies: { [AT]: at, [RT]: 'rt-1' } }));
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(0);
  });

  it('retries once after 401 token_expired, with the refreshed token and replayed body', async () => {
    const stale = await mintAccessToken();
    const fresh = await mintAccessToken({ expiresIn: 899 });
    let attempts = 0;
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh, 'rt-2')),
      'PATCH /api/v1/me/profile': async (req) => {
        attempts += 1;
        if (attempts === 1) return problem(401, 'token_expired');
        return json({ echoed: await req.json(), auth: req.headers.get('authorization') });
      },
    });
    const response = await proxy(
      request('PATCH', 'me/profile', {
        body: JSON.stringify({ headline: 'Hi' }),
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        cookies: { [AT]: stale, [RT]: 'rt-1' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: { headline: 'Hi' }, auth: `Bearer ${fresh}` });
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(parseSetCookies(response.headers).get(AT)!.value).toBe(fresh);
  });

  it('streamed body + token_expired: refreshes, sets cookies, returns 401 token_expired for the client to retry', async () => {
    const stale = await mintAccessToken();
    const fresh = await mintAccessToken({ expiresIn: 899 });
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh, 'rt-2')),
      'PUT /api/v1/me/blob': async (req) => {
        await req.text();
        return problem(401, 'token_expired');
      },
    });
    const response = await proxy(
      request('PUT', 'me/blob', {
        body: new Blob(['{"a":1}']).stream(),
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        cookies: { [AT]: stale, [RT]: 'rt-1' },
      }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('token_expired');
    expect(api.callsTo('PUT', '/api/v1/me/blob')).toHaveLength(1);
    expect(parseSetCookies(response.headers).get(AT)!.value).toBe(fresh);
  });

  it('retries only once: a second token_expired is passed through', async () => {
    const stale = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': async () => json(refreshResult(await mintAccessToken(), 'rt-2')),
      'GET /api/v1/me': () => problem(401, 'token_expired'),
    });
    const response = await proxy(request('GET', 'me', { cookies: { [AT]: stale, [RT]: 'rt-1' } }));
    expect(response.status).toBe(401);
    expect(api.callsTo('GET', '/api/v1/me')).toHaveLength(2);
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('does not refresh on a 401 with another code', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({ 'GET /api/v1/me': () => problem(401, 'unauthorized') });
    const response = await proxy(request('GET', 'me', { cookies: { [AT]: at, [RT]: 'rt-1' } }));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('unauthorized');
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(0);
  });

  it('grace path keeps the old rt cookie (only at is set)', async () => {
    const fresh = await mintAccessToken();
    await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh)),
      'GET /api/v1/me': () => json({}),
    });
    const response = await proxy(request('GET', 'me', { cookies: { [RT]: 'rt-old' } }));
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.value).toBe(fresh);
    expect(cookies.has(RT)).toBe(false);
  });

  it('a rejected refresh clears cookies and returns 401', async () => {
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token'),
    });
    const response = await proxy(request('GET', 'me', { cookies: { [RT]: 'rt-bad' } }));
    expect(response.status).toBe(401);
    expect(parseSetCookies(response.headers).get(RT)!.attrs.get('max-age')).toBe('0');
    expect(api.callsTo('GET', '/api/v1/me')).toHaveLength(0);
  });

  it('an unreachable API during refresh gives 503 and keeps cookies', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(503, 'service_unavailable') });
    const response = await proxy(request('GET', 'me', { cookies: { [RT]: 'rt-1' } }));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('anonymous calls go through without Authorization', async () => {
    const api = await stubApi({ 'GET /api/v1/users/u/profile': () => json({}) });
    await proxy(request('GET', 'users/u/profile'));
    expect(api.calls[0]!.headers.has('authorization')).toBe(false);
  });
});

describe('session ended upstream (revoked sid): cookies are cleared', () => {
  const expectCleared = (response: Response) => {
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)!.value).toBe('');
    expect(cookies.get(AT)!.attrs.get('max-age')).toBe('0');
    expect(cookies.get(RT)!.value).toBe('');
    expect(cookies.get(RT)!.attrs.get('max-age')).toBe('0');
    expect(response.headers.getSetCookie()).toHaveLength(2);
  };

  it('401 unauthorized for our access token: passes the 401 through and clears both cookies', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({
      'GET /api/v1/auth/sessions': () =>
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'x', status: 401, code: 'unauthorized' }),
          {
            status: 401,
            headers: { 'content-type': 'application/problem+json', 'x-request-id': 'r-1' },
          },
        ),
    });
    const response = await proxy(
      request('GET', 'auth/sessions', { cookies: { [AT]: at, [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('unauthorized');
    expect(response.headers.get('x-request-id')).toBe('r-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expectCleared(response);
    // A revoked session is not "expired": no refresh is attempted.
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(0);
  });

  it('also when the at is the only cookie', async () => {
    await stubApi({ 'GET /api/v1/me': () => problem(401, 'unauthorized') });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken() } }),
    );
    expect(response.status).toBe(401);
    expectCleared(response);
  });

  it('token_expired → refresh → retry → 401 unauthorized: clears instead of setting the new tokens', async () => {
    const fresh = await mintAccessToken();
    let attempts = 0;
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh, 'rt-2')),
      'GET /api/v1/me': () => {
        attempts += 1;
        return problem(401, attempts === 1 ? 'token_expired' : 'unauthorized');
      },
    });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(401);
    expect(api.callsTo('GET', '/api/v1/me')).toHaveLength(2);
    expect(api.callsTo('POST', '/api/v1/auth/refresh')).toHaveLength(1);
    expectCleared(response);
  });

  it('a second token_expired after a successful refresh is final: clears (no login ↔ home loop)', async () => {
    await stubApi({
      'POST /api/v1/auth/refresh': async () => json(refreshResult(await mintAccessToken(), 'rt-2')),
      'GET /api/v1/me': () => problem(401, 'token_expired'),
    });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('token_expired');
    expectCleared(response);
  });

  it('token_expired without a refresh token cannot be fixed: clears', async () => {
    await stubApi({ 'GET /api/v1/me': () => problem(401, 'token_expired') });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken() } }),
    );
    expect(response.status).toBe(401);
    expectCleared(response);
  });

  it('a refresh rejected with invalid_refresh_token on the token_expired retry path clears', async () => {
    await stubApi({
      'POST /api/v1/auth/refresh': () => problem(401, 'invalid_refresh_token'),
      'GET /api/v1/me': () => problem(401, 'token_expired'),
    });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('unauthorized');
    expectCleared(response);
  });

  it('streamed body + token_expired still hands the fresh cookies to the client retry (no clear)', async () => {
    const fresh = await mintAccessToken({ expiresIn: 899 });
    await stubApi({
      'POST /api/v1/auth/refresh': () => json(refreshResult(fresh, 'rt-2')),
      'PUT /api/v1/me/blob': async (req) => {
        await req.text();
        return problem(401, 'token_expired');
      },
    });
    const response = await proxy(
      request('PUT', 'me/blob', {
        body: new Blob(['{"a":1}']).stream(),
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' },
      }),
    );
    expect(response.status).toBe(401);
    expect(parseSetCookies(response.headers).get(AT)!.value).toBe(fresh);
  });

  it('an anonymous 401 (no access token sent) sets no cookies', async () => {
    await stubApi({ 'GET /api/v1/me': () => problem(401, 'unauthorized') });
    const response = await proxy(request('GET', 'me', { cookies: { other: 'x' } }));
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('a 401 without a readable problem body keeps the cookies', async () => {
    await stubApi({ 'GET /api/v1/me': () => new Response('nope', { status: 401 }) });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken() } }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('nope');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('403 forbidden is not a session problem: keeps the cookies', async () => {
    await stubApi({ 'GET /api/v1/admin/users': () => problem(403, 'forbidden') });
    const response = await proxy(
      request('GET', 'admin/users', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt' } }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('transient failures never clear cookies', () => {
  it.each([
    [503, 'service_unavailable'],
    [500, 'internal'],
    [502, 'service_unavailable'],
    [429, 'rate_limited'],
  ])('upstream %i %s is passed through, cookies kept', async (status, code) => {
    await stubApi({ 'GET /api/v1/me': () => problem(status, code) });
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('API unreachable (network error): 502, cookies kept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const response = await proxy(
      request('GET', 'me', { cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('service_unavailable');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('a rate-limited refresh (429) is transient: 503, cookies kept', async () => {
    await stubApi({ 'POST /api/v1/auth/refresh': () => problem(429, 'rate_limited') });
    const response = await proxy(request('GET', 'me', { cookies: { [RT]: 'rt-1' } }));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('refresh down + still-valid at + upstream token_expired: keeps the cookies', async () => {
    await stubApi({
      'POST /api/v1/auth/refresh': () => problem(503, 'service_unavailable'),
      'GET /api/v1/me': () => problem(401, 'token_expired'),
    });
    const response = await proxy(
      request('GET', 'me', {
        cookies: { [AT]: await mintAccessToken({ expiresIn: 10 }), [RT]: 'rt-1' },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('lazy config', () => {
  it('a thunk is not called at creation, then called once and cached', async () => {
    const thunk = vi.fn(() => testInput());
    const lazy = createApiProxyHandler(thunk);
    expect(thunk).not.toHaveBeenCalled();
    await stubApi({ 'GET /api/v1/me': () => json({ ok: true }) });
    expect((await lazy(request('GET', 'me'))).status).toBe(200);
    expect((await lazy(request('GET', 'me'))).status).toBe(200);
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it('an invalid thunk config fails on the request (not at creation), and is retried', async () => {
    const thunk = vi.fn(() => testInput({ apiInternalUrl: 'not a url' }));
    const lazy = createApiProxyHandler(thunk);
    await expect(lazy(request('GET', 'me'))).rejects.toThrow(/Invalid @udemy\/web-auth config/);
    await expect(lazy(request('GET', 'me'))).rejects.toThrow(/Invalid @udemy\/web-auth config/);
    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it('a plain invalid config still fails at creation (backwards compatible)', () => {
    expect(() => createApiProxyHandler(testInput({ apiInternalUrl: 'nope' }))).toThrow(
      /Invalid @udemy\/web-auth config/,
    );
  });
});
