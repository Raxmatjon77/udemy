import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { categoryTree, coursePage, CURSOR_PAGE_2 } from '@/test/fixtures/catalog';
import { API, setupMswServer } from '@/test/msw';

import CategoryPage from './categories/[slug]/page';
import CoursesPage from './courses/page';
import HomePage from './page';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'Vitest' }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.spyOn(console, 'error').mockImplementation(() => undefined);

const server = setupMswServer();

function html(element: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

const search = (query: Record<string, string> = {}) => Promise.resolve(query);

describe('catalog pages', () => {
  it('/courses renders the first page and the filters from the URL', async () => {
    let browse: URL | undefined;
    server.use(
      http.get(`${API}/catalog/categories`, () => HttpResponse.json(categoryTree)),
      http.get(`${API}/catalog/courses`, ({ request }) => {
        browse = new URL(request.url);
        return HttpResponse.json(coursePage(1, 3, CURSOR_PAGE_2));
      }),
    );
    const out = html(
      (await CoursesPage({
        params: Promise.resolve({}),
        searchParams: search({ level: 'EXPERT', q: 'node', cursor: 'not-from-the-url' }),
      })) as ReactElement,
    );
    expect(Object.fromEntries(browse!.searchParams)).toEqual({
      level: 'EXPERT',
      q: 'node',
      limit: '24',
    });
    expect(out.match(/data-testid="course-card"/g)).toHaveLength(3);
    expect(out).toContain('Load more courses');
  });

  it('/courses stays up with an error state when the API is down', async () => {
    server.use(
      http.get(`${API}/catalog/categories`, () => HttpResponse.error()),
      http.get(`${API}/catalog/courses`, () => new HttpResponse(null, { status: 502 })),
    );
    const out = html(
      (await CoursesPage({
        params: Promise.resolve({}),
        searchParams: search(),
      })) as ReactElement,
    );
    expect(out).toContain('The catalog is temporarily unavailable');
    expect(out).toContain('role="search"');
  });

  it('/ shows the newest courses and the category entry points, or degrades per section', async () => {
    server.use(
      http.get(`${API}/catalog/categories`, () => HttpResponse.json(categoryTree)),
      http.get(`${API}/catalog/courses`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('limit')).toBe('8');
        return HttpResponse.json(coursePage(1, 2, null));
      }),
    );
    const out = html((await HomePage()) as ReactElement);
    expect(out).toContain('New on Udemy');
    expect(out.match(/data-testid="course-card"/g)).toHaveLength(2);
    expect(out).toContain('href="/categories/web-development"');

    server.use(http.get(`${API}/catalog/courses`, () => HttpResponse.error()));
    const degraded = html((await HomePage()) as ReactElement);
    expect(degraded).toContain('The catalog is temporarily unavailable');
    expect(degraded).toContain('Browse by category');
  });

  it('/categories/[leaf] filters by the leaf, with a breadcrumb and sibling chips', async () => {
    let browse: URL | undefined;
    server.use(
      http.get(`${API}/catalog/categories`, () => HttpResponse.json(categoryTree)),
      http.get(`${API}/catalog/courses`, ({ request }) => {
        browse = new URL(request.url);
        return HttpResponse.json(coursePage(1, 1, null));
      }),
    );
    const out = html(
      (await CategoryPage({
        params: Promise.resolve({ slug: 'web-development' }),
        searchParams: search({ category: 'design', language: 'en' }),
      })) as ReactElement,
    );
    // The path decides the category; `?category=` is ignored.
    expect(Object.fromEntries(browse!.searchParams)).toEqual({
      category: 'web-development',
      language: 'en',
      limit: '24',
    });
    expect(out).toContain(
      '<h1 class="text-3xl font-bold tracking-tight">Web Development courses</h1>',
    );
    expect(out).toMatch(
      /aria-label="Breadcrumb".*href="\/courses".*href="\/categories\/development".*aria-current="page"[^>]*>Web Development/s,
    );
    expect(out).toMatch(
      /aria-label="Development subcategories".*All Development.*aria-current="page"[^>]*>Web Development.*Data Science/s,
    );
  });

  it('/categories/[unknown] is a 404', async () => {
    server.use(http.get(`${API}/catalog/categories`, () => HttpResponse.json(categoryTree)));
    await expect(
      CategoryPage({ params: Promise.resolve({ slug: 'cooking' }), searchParams: search() }),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) });
  });
});
