import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server, setupMockApi } from '@/test/msw';

import { POST } from './route';

setupMockApi();

const API = 'http://api.test/api/v1';
const ORIGIN = 'http://localhost:3002';
const AT = '__Host-udemy-admin-at';
const TICKET = 'T'.repeat(43);

/** An access token the BFF only decodes (expiry), never verifies: the API does that. */
function accessToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    sub: '0b1f6d1e-0000-4000-8000-000000000001',
    exp: Math.floor(Date.now() / 1000) + 600,
  })}.signature`;
}

function post(headers: Record<string, string>) {
  return POST(new Request(`${ORIGIN}/api/realtime/ticket`, { method: 'POST', headers }));
}

describe('POST /api/realtime/ticket', () => {
  it('returns a ticket from the API, called with the session', async () => {
    const token = accessToken();
    let seen: Request | undefined;
    server.use(
      http.post(`${API}/realtime/tickets`, ({ request }) => {
        seen = request;
        return HttpResponse.json(
          { ticket: TICKET, url: 'http://api.test', expiresAt: new Date().toISOString() },
          { status: 201 },
        );
      }),
    );
    const res = await post({ origin: ORIGIN, cookie: `${AT}=${token}` });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { ticket: string }).ticket).toBe(TICKET);
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${token}`);
  });

  it('rejects a cross-site request without calling the API', async () => {
    const res = await post({ origin: 'https://evil.test', cookie: `${AT}=${accessToken()}` });
    expect(res.status).toBe(403);
  });

  it('401 when signed out', async () => {
    const res = await post({ origin: ORIGIN });
    expect(res.status).toBe(401);
  });
});
