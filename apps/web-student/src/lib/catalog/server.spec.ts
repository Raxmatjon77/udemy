import { ErrorCode } from '@udemy/contracts';
import { ApiProblemError, ApiUnavailableError } from '@udemy/web-auth';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { categoryTree, coursePage, courseLanding, CURSOR_PAGE_2 } from '@/test/fixtures/catalog';
import { API, setupMswServer } from '@/test/msw';

import { browseCourses, getCategoryTree, getCourseLanding, settle } from './server';

vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({ 'user-agent': 'Vitest UA', 'x-real-ip': '203.0.113.7', cookie: 'secret=1' }),
}));

const server = setupMswServer();

describe('catalog server reads', () => {
  it('browses with the filters and the exact cursor, as the BFF client, without the session', async () => {
    let seen: Request | undefined;
    server.use(
      http.get(`${API}/catalog/courses`, ({ request }) => {
        seen = request;
        return HttpResponse.json(coursePage(1, 2, null));
      }),
    );
    const page = await browseCourses(
      { category: 'design', level: 'EXPERT', q: 'figma' },
      { cursor: CURSOR_PAGE_2, limit: 12 },
    );
    expect(page.items).toHaveLength(2);
    const url = new URL(seen!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: 'design',
      level: 'EXPERT',
      q: 'figma',
      cursor: CURSOR_PAGE_2,
      limit: '12',
    });
    expect(seen!.headers.get('x-client-id')).toBe('student-bff');
    expect(seen!.headers.get('x-client-ip')).toBe('203.0.113.7');
    expect(seen!.headers.get('x-client-user-agent')).toBe('Vitest UA');
    expect(seen!.headers.get('authorization')).toBeNull();
    expect(seen!.headers.get('cookie')).toBeNull();
  });

  it('reads the category tree', async () => {
    server.use(http.get(`${API}/catalog/categories`, () => HttpResponse.json(categoryTree)));
    expect((await getCategoryTree()).map((group) => group.slug)).toEqual(['development', 'design']);
  });

  it('returns the landing, or null for course_not_found', async () => {
    server.use(
      http.get(`${API}/catalog/courses/by-slug/:slug`, ({ params }) =>
        params.slug === 'modern-typescript'
          ? HttpResponse.json(courseLanding())
          : HttpResponse.json(
              {
                type: 'about:blank',
                title: 'Not Found',
                status: 404,
                code: ErrorCode.CourseNotFound,
              },
              { status: 404, headers: { 'content-type': 'application/problem+json' } },
            ),
      ),
    );
    expect((await getCourseLanding('modern-typescript'))?.id).toBeDefined();
    expect(await getCourseLanding('unpublished-course')).toBeNull();
  });

  it('never calls the API for something that is not a slug', async () => {
    // No handler: an API call would fail the test (onUnhandledRequest: 'error').
    expect(await getCourseLanding('..%2Fadmin')).toBeNull();
    expect(await getCourseLanding('UPPER')).toBeNull();
  });

  it('turns 5xx, network errors and contract mismatches into ApiUnavailableError', async () => {
    server.use(
      http.get(`${API}/catalog/categories`, () => new HttpResponse(null, { status: 503 })),
    );
    await expect(getCategoryTree()).rejects.toBeInstanceOf(ApiUnavailableError);

    server.use(http.get(`${API}/catalog/categories`, () => HttpResponse.error()));
    await expect(getCategoryTree()).rejects.toBeInstanceOf(ApiUnavailableError);

    server.use(http.get(`${API}/catalog/courses`, () => HttpResponse.json({ items: 'nope' })));
    await expect(browseCourses({})).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('passes other 4xx on as ApiProblemError', async () => {
    server.use(
      http.get(`${API}/catalog/courses`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            code: ErrorCode.ValidationFailed,
          },
          { status: 400 },
        ),
      ),
    );
    await expect(browseCourses({})).rejects.toBeInstanceOf(ApiProblemError);
  });

  it('settle() keeps a failed read as a value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await settle(Promise.reject(new Error('down')))).toMatchObject({ ok: false });
    expect(await settle(Promise.resolve(1))).toEqual({ ok: true, data: 1 });
    spy.mockRestore();
  });
});

describe('settle()', () => {
  it("rethrows Next's control-flow errors instead of turning them into an error state", async () => {
    const { notFound } = await import('next/navigation');
    let thrown: unknown;
    try {
      notFound();
    } catch (error) {
      thrown = error;
    }
    await expect(settle(Promise.reject(thrown))).rejects.toBe(thrown);
  });
});
