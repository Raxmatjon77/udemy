import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CHANNEL,
  broadcastLogout,
  createProxyFetch,
  createProxyJson,
  fetchRealtimeTicket,
  logout,
  onLogoutBroadcast,
  parseRetryAfter,
  ProxyFetchError,
  REALTIME_TICKET_PATH,
  tabId,
} from './index';

/*
 * Browser helpers under Node: Node 22 has a real BroadcastChannel (delivered across channel
 * objects of the same process, like tabs of one origin); `window.location` is stubbed.
 */

const assign = vi.fn();
const cleanups: (() => void)[] = [];

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('window', { location: { assign, pathname: '/account/sessions', search: '' } });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

/** Another "tab": a raw channel that records every message it sees. */
function otherTab() {
  const ch = new BroadcastChannel(AUTH_CHANNEL);
  const seen: unknown[] = [];
  ch.onmessage = (event: MessageEvent<unknown>) => seen.push(event.data);
  cleanups.push(() => ch.close());
  return { seen, post: (data: unknown) => ch.postMessage(data) };
}

function listen() {
  const onLogout = vi.fn();
  cleanups.push(onLogoutBroadcast(onLogout));
  return onLogout;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function problemResponse(status: number, code: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, code }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

describe('logout broadcast (BUG #2: the sending tab ignores its own message)', () => {
  it('the tab that broadcasts does not run its own listener; other tabs do', async () => {
    const onLogout = listen();
    const other = otherTab();
    broadcastLogout();
    await vi.waitFor(() => expect(other.seen).toHaveLength(1));
    await settle();
    expect(other.seen[0]).toEqual({ type: 'logout', tabId: tabId() });
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('a logout from another tab (or an older client without tabId) runs the listener', async () => {
    const onLogout = listen();
    const other = otherTab();
    other.post({ type: 'logout', tabId: 'another-tab' });
    await vi.waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    other.post({ type: 'logout' });
    await vi.waitFor(() => expect(onLogout).toHaveBeenCalledTimes(2));
    other.post({ type: 'something-else', tabId: 'another-tab' });
    await settle();
    expect(onLogout).toHaveBeenCalledTimes(2);
  });

  it('the tab id is stable for the document', () => {
    expect(tabId()).toBe(tabId());
    expect(tabId()).toMatch(/\S{8,}/);
  });
});

describe('logout()', () => {
  it('posts to /api/auth/logout, broadcasts (to other tabs only) and goes to the login page', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onLogout = listen();
    const other = otherTab();

    await logout({ loginPath: '/login' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(assign).toHaveBeenCalledWith('/login');
    await vi.waitFor(() => expect(other.seen).toHaveLength(1));
    await settle();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('BUG #5: a network error still broadcasts and navigates (no rejection)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const other = otherTab();
    await expect(logout()).resolves.toBeUndefined();
    expect(assign).toHaveBeenCalledWith('/login');
    await vi.waitFor(() => expect(other.seen).toEqual([{ type: 'logout', tabId: tabId() }]));
  });

  it('a timeout (aborted request) still broadcasts and navigates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await logout({ loginPath: '/sign-in' });
    expect(assign).toHaveBeenCalledWith('/sign-in');
  });

  it('a non-2xx answer from the BFF still signs out locally', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problemResponse(403, 'forbidden')),
    );
    await logout();
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('logout-all: 204 and 401 (already gone) both broadcast and navigate', async () => {
    for (const status of [204, 401]) {
      assign.mockReset();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          status === 204 ? new Response(null, { status }) : problemResponse(status, 'unauthorized'),
        ),
      );
      await logout({ all: true });
      expect(assign).toHaveBeenCalledWith('/login');
    }
  });

  it('logout-all: a failure throws ProxyFetchError (with Retry-After) and stays put', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problemResponse(503, 'service_unavailable', { 'retry-after': '30' })),
    );
    const other = otherTab();
    const error = await logout({ all: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyFetchError);
    expect(error).toMatchObject({
      status: 503,
      code: 'service_unavailable',
      retryAfterSeconds: 30,
    });
    expect(assign).not.toHaveBeenCalled();
    await settle();
    expect(other.seen).toEqual([]);
  });

  it('logout-all: a network error rejects (the user must retry) without navigating', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(logout({ all: true })).rejects.toThrow(TypeError);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('ProxyFetchError (BUG #4: keeps the response headers)', () => {
  it('fromResponse: status, parsed problem, headers and retryAfterSeconds', async () => {
    const error = await ProxyFetchError.fromResponse(
      problemResponse(429, 'too_many_attempts', { 'retry-after': '120', 'x-request-id': 'r-9' }),
    );
    expect(error.status).toBe(429);
    expect(error.code).toBe('too_many_attempts');
    expect(error.problem?.status).toBe(429);
    expect(error.retryAfter).toBe('120');
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.headers.get('x-request-id')).toBe('r-9');
  });

  it('tolerates a non-JSON (or non-problem) body', async () => {
    const html = await ProxyFetchError.fromResponse(new Response('<html>', { status: 502 }));
    expect(html.problem).toBeNull();
    expect(html.status).toBe(502);
    expect(html.retryAfterSeconds).toBeNull();
    const other = await ProxyFetchError.fromResponse(
      new Response('{"status":"nope"}', { status: 500 }),
    );
    expect(other.problem).toBeNull();
  });

  it('keeps the (status, problem) constructor and accepts a cause', () => {
    const legacy = new ProxyFetchError(404, null);
    expect(legacy.message).toBe('Request failed with status 404');
    expect(legacy.headers.has('retry-after')).toBe(false);
    const cause = new Error('zod');
    expect(new ProxyFetchError(502, null, { cause }).cause).toBe(cause);
  });

  it('createProxyJson throws it with the headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problemResponse(429, 'rate_limited', { 'retry-after': '7' })),
    );
    const proxyJson = createProxyJson();
    const error = await proxyJson('/auth/email/verification-requests', {
      method: 'POST',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyFetchError);
    expect((error as ProxyFetchError).retryAfterSeconds).toBe(7);
  });

  it('parseRetryAfter reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('90')).toBe(90);
    const now = Date.parse('2026-10-10T10:00:00Z');
    expect(parseRetryAfter('Sat, 10 Oct 2026 10:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter('Sat, 10 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('createProxyFetch on a final 401', () => {
  it('sends the user to /login?next=<here> (the BFF already cleared the cookies)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problemResponse(401, 'unauthorized')),
    );
    const response = await createProxyFetch()('/auth/sessions');
    expect(response.status).toBe(401);
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/account/sessions')}`);
  });

  it('retries a token_expired once before giving up', async () => {
    const fetchMock = vi.fn(async () => problemResponse(401, 'token_expired'));
    vi.stubGlobal('fetch', fetchMock);
    await createProxyFetch()('/me');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe('fetchRealtimeTicket', () => {
  const TICKET = {
    ticket: 'B'.repeat(43),
    url: 'http://localhost:4000',
    expiresAt: '2026-10-10T10:00:30.000Z',
  };

  it('POSTs to the BFF ticket route (same origin, no body) and returns the parsed ticket', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(TICKET), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRealtimeTicket()).resolves.toEqual(TICKET);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(REALTIME_TICKET_PATH);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
  });

  it('throws ProxyFetchError with the problem and Retry-After, and never redirects to login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = problemResponse(429, 'rate_limited');
        response.headers.set('retry-after', '30');
        return response;
      }),
    );
    const error = await fetchRealtimeTicket().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyFetchError);
    expect((error as ProxyFetchError).code).toBe('rate_limited');
    expect((error as ProxyFetchError).retryAfterSeconds).toBe(30);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problemResponse(401, 'unauthorized')),
    );
    await expect(fetchRealtimeTicket()).rejects.toBeInstanceOf(ProxyFetchError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a RealtimeTicket with a 502 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ticket: 'x' }), { status: 201 })),
    );
    const error = await fetchRealtimeTicket().catch((e: unknown) => e);
    expect((error as ProxyFetchError).status).toBe(502);
  });
});
