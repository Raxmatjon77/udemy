import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { COURSE_ID, courseLanding } from '@/test/fixtures/catalog';
import { API, setupMswServer } from '@/test/msw';

import CoursePage, { generateMetadata } from './page';

const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY3OA==';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': NONCE, 'user-agent': 'Vitest' }),
  // Signed out: the session cookies are absent.
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const server = setupMswServer();
const ORIGIN = 'http://localhost:3000';

/** The landing, and no price for it (not for sale) unless a test serves one; no reviews. */
function serveLanding(landing = courseLanding()) {
  server.use(
    http.get(`${API}/commerce/prices`, () => HttpResponse.json({ items: [] })),
    http.get(`${API}/engagement/ratings`, ({ request }) =>
      HttpResponse.json({
        items: (new URL(request.url).searchParams.get('courseIds') ?? '')
          .split(',')
          .map((courseId) => ({
            courseId,
            average: null,
            count: 0,
            histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
          })),
      }),
    ),
    http.get(`${API}/catalog/courses/by-slug/:slug`, ({ params }) =>
      params.slug === landing.slug
        ? HttpResponse.json(landing)
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
}

function props(slug: string) {
  return { params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) };
}

async function renderPage(slug: string): Promise<string> {
  const element = (await CoursePage(props(slug))) as ReactElement;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

function jsonLdScripts(html: string): { attrs: string; json: string }[] {
  return [
    ...html.matchAll(/<script([^>]*type="application\/ld\+json"[^>]*)>([\s\S]*?)<\/script>/g),
  ].map((match) => ({ attrs: match[1]!, json: match[2]! }));
}

describe('/course/[slug] generateMetadata', () => {
  it('describes the course with a canonical URL and the thumbnail as Open Graph image', async () => {
    serveLanding();
    const metadata = await generateMetadata(props('modern-typescript'));
    const canonical = `${ORIGIN}/course/modern-typescript`;
    const image = `${ORIGIN}/media/course-thumbnail/${COURSE_ID}?variant=w750`;
    expect(metadata).toEqual({
      title: 'Modern TypeScript </script> & more',
      description: 'From the type system to production-grade Node services',
      alternates: { canonical },
      openGraph: {
        type: 'website',
        siteName: 'Udemy',
        url: canonical,
        title: 'Modern TypeScript </script> & more',
        description: 'From the type system to production-grade Node services',
        images: [
          { url: image, width: 750, height: 422, alt: 'Modern TypeScript </script> & more' },
        ],
        locale: 'en',
      },
      twitter: {
        card: 'summary_large_image',
        title: 'Modern TypeScript </script> & more',
        description: 'From the type system to production-grade Node services',
        images: [image],
      },
    });
  });

  it('falls back to the description text when there is no subtitle', async () => {
    serveLanding(courseLanding({ subtitle: null }));
    const metadata = await generateMetadata(props('modern-typescript'));
    expect(metadata.description).toBe(
      'Overview Learn TypeScript the practical way. Generics Narrowing',
    );
  });

  it('is a non-indexed "not found" for an unknown slug', async () => {
    serveLanding();
    expect(await generateMetadata(props('no-such-course'))).toEqual({
      title: 'Course not found',
      robots: { index: false },
    });
  });
});

describe('/course/[slug] page', () => {
  it('embeds schema.org Course JSON-LD with the CSP nonce, escaped against </script>', async () => {
    serveLanding();
    const html = await renderPage('modern-typescript');
    const scripts = jsonLdScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.attrs).toContain(`nonce="${NONCE}"`);
    // The title's `</script>` cannot end the element early.
    expect(scripts[0]!.json).not.toMatch(/<\/script/i);
    expect(scripts[0]!.json).toContain('\\u003c/script\\u003e \\u0026 more');

    expect(JSON.parse(scripts[0]!.json)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Course',
      '@id': `${ORIGIN}/course/modern-typescript`,
      url: `${ORIGIN}/course/modern-typescript`,
      name: 'Modern TypeScript </script> & more',
      description: 'From the type system to production-grade Node services',
      image: `${ORIGIN}/media/course-thumbnail/${COURSE_ID}?variant=w750`,
      provider: { '@type': 'Organization', name: 'Udemy', sameAs: ORIGIN },
      datePublished: '2026-09-01T08:00:00.000000+00:00',
      dateModified: '2026-10-05T12:30:00.000000+00:00',
      inLanguage: 'en',
      educationalLevel: 'Intermediate',
      instructor: { '@type': 'Person', name: 'Ada Lovelace' },
      creator: { '@type': 'Person', name: 'Ada Lovelace' },
      teaches: ['Model domains with types', 'Write safe generics'],
      coursePrerequisites: ['Basic JavaScript'],
      about: 'Web Development',
      timeRequired: 'PT1H6M',
    });
    expect(html).toContain('data-state="not_for_sale"');
  });

  it('shows the price from the public prices endpoint in the PurchaseBox', async () => {
    let asked: string | null = null;
    serveLanding();
    server.use(
      http.get(`${API}/commerce/prices`, ({ request }) => {
        asked = new URL(request.url).searchParams.get('courseIds');
        return HttpResponse.json({
          items: [
            {
              courseId: COURSE_ID,
              amount: '24.99',
              currency: 'USD',
              isFree: false,
              slug: 'a-course',
              title: 'A course',
            },
          ],
        });
      }),
    );
    const html = await renderPage('modern-typescript');
    expect(asked).toBe(COURSE_ID);
    expect(html).toContain('$24.99');
    expect(html).toContain('data-state="add_to_cart"');
  });

  it('says the price could not be loaded when the prices endpoint fails', async () => {
    serveLanding();
    server.use(http.get(`${API}/commerce/prices`, () => HttpResponse.error()));
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const html = await renderPage('modern-typescript');
    expect(html).toContain('Enrollment unavailable');
  });

  it('leaves the instructor out of the page and the JSON-LD when the API hides them', async () => {
    serveLanding(courseLanding({ instructor: null }));
    const html = await renderPage('modern-typescript');
    const data = JSON.parse(jsonLdScripts(html)[0]!.json) as Record<string, unknown>;
    expect(data).not.toHaveProperty('instructor');
    expect(data).not.toHaveProperty('creator');
    expect(html).not.toContain('Ada Lovelace');
  });

  it.each(['no-such-course', 'Not_A_Slug'])('is a 404 for %s', async (slug) => {
    serveLanding();
    await expect(CoursePage(props(slug))).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});

describe('/course/[slug] ratings (Phase 5)', () => {
  it('renders the rating summary from the public ratings endpoint on the server', async () => {
    serveLanding();
    server.use(
      http.get(`${API}/engagement/ratings`, () =>
        HttpResponse.json({
          items: [
            {
              courseId: COURSE_ID,
              average: '4.5',
              count: 2,
              histogram: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 1 },
            },
          ],
        }),
      ),
    );
    const html = await renderPage('modern-typescript');
    expect(html).toContain('aria-label="Rated 4.5 out of 5"');
    expect(html).toContain('2 ratings');
    expect(html).toContain('Student feedback');
  });

  it('still renders when the ratings cannot be loaded', async () => {
    serveLanding();
    server.use(http.get(`${API}/engagement/ratings`, () => HttpResponse.error()));
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const html = await renderPage('modern-typescript');
    expect(html).toContain('Student feedback');
    expect(html).not.toContain('Rated ');
  });
});
