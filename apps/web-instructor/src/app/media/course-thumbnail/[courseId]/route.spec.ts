import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { workingThumbnailApiPath } from '@/lib/media-routes';
import { IDS, signedUrl } from '@/test/fixtures';
import { server, setupMockApi } from '@/test/msw';

import { GET } from './route';

setupMockApi();

const API = 'http://api.test/api/v1';
const AT = '__Host-udemy-instructor-at';

/** An access token the BFF only decodes (expiry), never verifies: the API does that. */
function accessToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    sub: IDS.owner,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}.signature`;
}

function get(courseId: string, query = '', cookie?: string) {
  return GET(
    new Request(`http://localhost:3001/media/course-thumbnail/${courseId}${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ courseId }) },
  );
}

describe('GET /media/course-thumbnail/[courseId] (working copy)', () => {
  it.each(['not-a-uuid', '..', `${IDS.course}x`])(
    'answers 404 for a non-uuid id (%s) without calling the API',
    async (id) => {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it('builds the owner API path, ignoring the cache key', () => {
    expect(
      workingThumbnailApiPath(IDS.course, new URLSearchParams(`variant=w480&v=${IDS.asset}`)),
    ).toBe(`/courses/${IDS.course}/thumbnail?variant=w480`);
    expect(workingThumbnailApiPath(IDS.course, new URLSearchParams())).toBe(
      `/courses/${IDS.course}/thumbnail?variant=w750`,
    );
    expect(workingThumbnailApiPath(IDS.course, new URLSearchParams('variant=w9999'))).toBeNull();
  });

  it('forwards the owner session and 302s privately to the presigned URL', async () => {
    const token = accessToken();
    const image = signedUrl('thumb/w480.jpg', 3600);
    let seen: Request | undefined;
    server.use(
      http.get(`${API}/courses/:courseId/thumbnail`, ({ request }) => {
        seen = request;
        return HttpResponse.json(image);
      }),
    );
    const res = await get(IDS.course, `?variant=w480&v=${IDS.asset}`, `${AT}=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(image.url);
    expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(res.headers.get('vary')).toBe('cookie');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/courses/${IDS.course}/thumbnail`);
    expect(new URL(seen!.url).search).toBe('?variant=w480');
    expect(seen!.headers.get('authorization')).toBe(`Bearer ${token}`);
  });

  it('passes 409 media_not_ready on as an uncached problem (the builder shows the status)', async () => {
    server.use(
      http.get(`${API}/courses/:courseId/thumbnail`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Conflict', status: 409, code: 'media_not_ready' },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const res = await get(IDS.course, '', `${AT}=${accessToken()}`);
    expect(res.status).toBe(409);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('location')).toBeNull();
  });
});
