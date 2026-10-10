import { describe, expect, it, vi } from 'vitest';

import { revisionThumbnailApiPath } from '@/lib/media-routes';
import { ADMIN_ID, REVISION_ID, signedUrl } from '@/test/fixtures';

import { GET } from './route';

const AT = '__Host-udemy-admin-at';

/** An access token the BFF only decodes (expiry), never verifies: the API does that. */
function accessToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    sub: ADMIN_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}.signature`;
}

/** Stubs the API (`API_INTERNAL_URL` = http://api.test) and records the calls. */
function stubApi(answer: () => Response) {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return answer();
    }),
  );
  return calls;
}

function get(revisionId: string, query = '', cookie?: string) {
  return GET(
    new Request(`http://localhost:3002/media/revision-thumbnail/${revisionId}${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ revisionId }) },
  );
}

describe('GET /media/revision-thumbnail/[revisionId]', () => {
  it.each(['not-a-uuid', '..', `${REVISION_ID}x`])(
    'answers 404 for a non-uuid id (%s) without calling the API',
    async (id) => {
      const calls = stubApi(() => new Response(null, { status: 500 }));
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    },
  );

  it('builds the admin API path and validates the variant', () => {
    expect(revisionThumbnailApiPath(REVISION_ID, new URLSearchParams('variant=w750'))).toBe(
      `/admin/course-revisions/${REVISION_ID}/thumbnail?variant=w750`,
    );
    expect(revisionThumbnailApiPath(REVISION_ID, new URLSearchParams('variant=big'))).toBeNull();
  });

  it('forwards the admin session and 302s privately to the presigned URL', async () => {
    const token = accessToken();
    const image = signedUrl('thumb/w480.jpg', 3600);
    const calls = stubApi(() => Response.json(image));
    const res = await get(REVISION_ID, '?variant=w480', `${AT}=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(image.url);
    expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe(
      `/api/v1/admin/course-revisions/${REVISION_ID}/thumbnail`,
    );
    expect(call.headers.get('authorization')).toBe(`Bearer ${token}`);
  });

  it('passes 409 media_not_ready on as an uncached problem', async () => {
    stubApi(() =>
      Response.json(
        { type: 'about:blank', title: 'Conflict', status: 409, code: 'media_not_ready' },
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const res = await get(REVISION_ID, '', `${AT}=${accessToken()}`);
    expect(res.status).toBe(409);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
