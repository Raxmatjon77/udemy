import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { courseThumbnailApiPath } from '@/lib/catalog/media-routes';
import { COURSE_ID } from '@/test/fixtures/catalog';
import { API, setupMswServer } from '@/test/msw';

import { GET } from './route';

const server = setupMswServer();

function get(courseId: string, query = '', cookie?: string) {
  return GET(
    new Request(`http://localhost:3000/media/course-thumbnail/${courseId}${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ courseId }) },
  );
}

const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

describe('GET /media/course-thumbnail/[courseId]', () => {
  it.each(['not-a-uuid', '..', '1234', `${COURSE_ID}x`, 'C0C0C0C0-0000-4000-8000'])(
    'answers 404 for a non-uuid id (%s) without calling the API',
    async (id) => {
      // No handler registered: any API call would fail the test.
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it('answers 404 for an unknown variant', async () => {
    expect((await get(COURSE_ID, '?variant=w9999')).status).toBe(404);
    expect(courseThumbnailApiPath(COURSE_ID, new URLSearchParams('variant=w480'))).toBe(
      `/catalog/courses/${COURSE_ID}/images/thumbnail?variant=w480`,
    );
    expect(courseThumbnailApiPath(COURSE_ID, new URLSearchParams())).toBe(
      `/catalog/courses/${COURSE_ID}/images/thumbnail?variant=w750`,
    );
  });

  it('302s to the presigned media URL, anonymously and publicly cacheable', async () => {
    let seen: Request | undefined;
    server.use(
      http.get(`${API}/catalog/courses/:courseId/images/thumbnail`, ({ request }) => {
        seen = request;
        return HttpResponse.json({
          url: `http://127.0.0.1:9000/udemy-media/thumb/w480.webp?X-Amz-Signature=abc`,
          expiresAt: inOneHour(),
        });
      }),
    );
    const res = await get(COURSE_ID, '?variant=w480', '__Host-udemy-student-at=token');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://127.0.0.1:9000/udemy-media/thumb/w480.webp?X-Amz-Signature=abc',
    );
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/catalog/courses/${COURSE_ID}/images/thumbnail`,
    );
    expect(new URL(seen!.url).searchParams.get('variant')).toBe('w480');
    expect(seen!.headers.get('authorization')).toBeNull();
  });

  it('refuses to redirect anywhere but MEDIA_PUBLIC_ORIGIN', async () => {
    server.use(
      http.get(`${API}/catalog/courses/:courseId/images/thumbnail`, () =>
        HttpResponse.json({ url: 'https://evil.example/x.png', expiresAt: inOneHour() }),
      ),
    );
    const res = await get(COURSE_ID);
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
  });

  it('passes a missing thumbnail on as an uncached 404', async () => {
    server.use(
      http.get(`${API}/catalog/courses/:courseId/images/thumbnail`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Not Found', status: 404, code: 'not_found' },
          { status: 404 },
        ),
      ),
    );
    const res = await get(COURSE_ID);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});
