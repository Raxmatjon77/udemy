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
import { createRealtimeTicketHandler, REALTIME_TICKET_PATH } from './realtime-ticket';

const REALTIME = 'http://localhost:4000';
const TICKETS_API = '/api/v1/realtime/tickets';
const AT = '__Host-udemy-student-at';
const RT = '__Host-udemy-student-rt';
const TICKET = 'A'.repeat(40) + '_-9';

const config = testConfig({ realtimeOrigin: REALTIME });
const handler = createRealtimeTicketHandler(config);

afterEach(() => vi.unstubAllGlobals());

function post(
  init: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string | undefined>;
    body?: string;
  } = {},
) {
  const headers = new Headers({ origin: ORIGIN, 'user-agent': 'UA', ...init.headers });
  if (init.cookies) headers.set('cookie', cookieHeader(init.cookies));
  return new Request(`${ORIGIN}${REALTIME_TICKET_PATH}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body ?? null,
  });
}

const ticket = (overrides: Record<string, unknown> = {}) =>
  json({ ticket: TICKET, url: REALTIME, expiresAt: isoIn(30), ...overrides }, 201);

describe('createRealtimeTicketHandler', () => {
  it('returns the api ticket (201, no-store), calling the api with the session and client credentials', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({ [`POST ${TICKETS_API}`]: () => ticket() });

    const response = await handler(post({ cookies: { [AT]: at, [RT]: 'rt-1' } }));

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ticket: TICKET, url: REALTIME, expiresAt: expect.any(String) });

    const [call] = api.callsTo('POST', TICKETS_API);
    expect(call!.headers.get('authorization')).toBe(`Bearer ${at}`);
    expect(call!.headers.get('x-client-id')).toBe('student-bff');
    expect(await call!.text()).toBe('');
  });

  it('ignores a request body (never forwarded)', async () => {
    const api = await stubApi({ [`POST ${TICKETS_API}`]: () => ticket() });
    const response = await handler(
      post({
        cookies: { [AT]: await mintAccessToken() },
        headers: { 'content-type': 'text/plain' },
        body: 'ignored',
      }),
    );
    expect(response.status).toBe(201);
    expect(await api.calls[0]!.text()).toBe('');
  });

  it('accepts a ws:// url naming the configured realtime origin', async () => {
    await stubApi({ [`POST ${TICKETS_API}`]: () => ticket({ url: 'ws://localhost:4000' }) });
    const response = await handler(post({ cookies: { [AT]: await mintAccessToken() } }));
    expect(response.status).toBe(201);
    expect(((await response.json()) as { url: string }).url).toBe('ws://localhost:4000');
  });

  it('405 for any method but POST', async () => {
    const api = await stubApi({});
    const response = await handler(post({ method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.test' }],
    ['no Origin', { origin: '' }],
  ])('403 for %s, without calling the api', async (_label, headers) => {
    const api = await stubApi({});
    const request = post({ headers, cookies: { [AT]: await mintAccessToken() } });
    if (!headers.origin) request.headers.delete('origin');
    const response = await handler(request);
    expect(response.status).toBe(403);
    expect(api.calls).toHaveLength(0);
  });

  it('accepts Sec-Fetch-Site: same-origin when the Origin differs (127.0.0.1 vs localhost)', async () => {
    const api = await stubApi({ [`POST ${TICKETS_API}`]: () => ticket() });
    const response = await handler(
      post({
        headers: { origin: 'https://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
        cookies: { [AT]: await mintAccessToken() },
      }),
    );
    expect(response.status).toBe(201);
    expect(api.callsTo('POST', TICKETS_API)).toHaveLength(1);
  });

  it('401 without any session cookie, without calling the api', async () => {
    const api = await stubApi({});
    const response = await handler(post());
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('unauthorized');
    expect(api.calls).toHaveLength(0);
  });

  it('refreshes an expiring session first and sets the new cookies', async () => {
    const fresh = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({
          accessToken: fresh,
          accessTokenExpiresAt: isoIn(900),
          refreshToken: 'rt-2',
          refreshTokenExpiresAt: isoIn(86_400),
        }),
      [`POST ${TICKETS_API}`]: () => ticket(),
    });

    const response = await handler(
      post({ cookies: { [AT]: await mintAccessToken({ expiresIn: 10 }), [RT]: 'rt-1' } }),
    );

    expect(response.status).toBe(201);
    expect(api.callsTo('POST', TICKETS_API)[0]!.headers.get('authorization')).toBe(
      `Bearer ${fresh}`,
    );
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)?.value).toBe(fresh);
    expect(cookies.get(RT)?.value).toBe('rt-2');
  });

  it('passes a 429 on with Retry-After, no-store', async () => {
    await stubApi({
      [`POST ${TICKETS_API}`]: () => {
        const response = problem(429, 'rate_limited');
        response.headers.set('retry-after', '120');
        return response;
      },
    });
    const response = await handler(post({ cookies: { [AT]: await mintAccessToken() } }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as { code: string }).code).toBe('rate_limited');
  });

  it('passes 503 realtime_unavailable on', async () => {
    await stubApi({ [`POST ${TICKETS_API}`]: () => problem(503, 'realtime_unavailable') });
    const response = await handler(post({ cookies: { [AT]: await mintAccessToken() } }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('realtime_unavailable');
  });

  it('clears the cookies when the api ended the session (401 unauthorized)', async () => {
    await stubApi({ [`POST ${TICKETS_API}`]: () => problem(401, 'unauthorized') });
    const response = await handler(
      post({ cookies: { [AT]: await mintAccessToken(), [RT]: 'rt-1' } }),
    );
    expect(response.status).toBe(401);
    const cookies = parseSetCookies(response.headers);
    expect(cookies.get(AT)?.attrs.get('max-age')).toBe('0');
    expect(cookies.get(RT)?.attrs.get('max-age')).toBe('0');
  });

  it.each([
    ['a body that is not a RealtimeTicket', { ticket: 'short' }],
    ['a url on another origin than REALTIME_PUBLIC_URL', { url: 'https://evil.test' }],
  ])('502 for %s, never echoing the ticket', async (_label, overrides) => {
    await stubApi({ [`POST ${TICKETS_API}`]: () => ticket(overrides) });
    const response = await handler(post({ cookies: { [AT]: await mintAccessToken() } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(TICKET);
  });

  it('accepts any valid url when the BFF has no realtime origin configured', async () => {
    await stubApi({
      [`POST ${TICKETS_API}`]: () => ticket({ url: 'https://rt.example.test' }),
    });
    const bare = createRealtimeTicketHandler(testConfig());
    const response = await bare(post({ cookies: { [AT]: await mintAccessToken() } }));
    expect(response.status).toBe(201);
  });
});
