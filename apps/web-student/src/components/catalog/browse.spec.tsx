/** @vitest-environment jsdom */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { categoryTree, coursePage, CURSOR_PAGE_2 } from '@/test/fixtures/catalog';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { BrowseFilters } from './browse-filters';
import { BrowseResults } from './browse-results';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const server = setupMswServer();

beforeEach(() => push.mockReset());

describe('<BrowseFilters>', () => {
  it('navigates to the URL of the new filters, keeping the others and dropping no cursor into it', async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <BrowseFilters
        basePath="/courses"
        filters={{ q: 'typescript', language: 'en' }}
        categories={categoryTree.items}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Level'), 'BEGINNER');
    expect(push).toHaveBeenLastCalledWith('/courses?level=BEGINNER&language=en&q=typescript', {
      scroll: false,
    });

    await user.selectOptions(screen.getByLabelText('Category'), 'web-development');
    expect(push).toHaveBeenLastCalledWith(
      '/courses?category=web-development&language=en&q=typescript',
      { scroll: false },
    );

    await user.selectOptions(screen.getByLabelText('Language'), '');
    expect(push).toHaveBeenLastCalledWith('/courses?q=typescript', { scroll: false });
  });

  it('offers the two-level category tree, groups included', () => {
    renderWithQuery(
      <BrowseFilters basePath="/courses" filters={{}} categories={categoryTree.items} />,
    );
    const select = screen.getByLabelText('Category');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', 'development', 'web-development', 'data-science', 'design']);
  });

  it('searches on Enter, and refuses a search shorter than the API minimum', async () => {
    const user = userEvent.setup();
    renderWithQuery(<BrowseFilters basePath="/categories/design" filters={{ level: 'EXPERT' }} />);
    expect(screen.queryByLabelText('Category')).toBeNull();

    const search = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(search, 'ab{Enter}');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/at least 3 characters/);
    expect(search.getAttribute('aria-invalid')).toBe('true');

    await user.type(search, 'c{Enter}');
    expect(push).toHaveBeenLastCalledWith('/categories/design?level=EXPERT&q=abc', {
      scroll: false,
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears every filter', async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <BrowseFilters basePath="/courses" filters={{ level: 'EXPERT', q: 'react' }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(push).toHaveBeenLastCalledWith('/courses', { scroll: false });
  });
});

describe('<BrowseResults>', () => {
  // Later pages ask for their prices (Phase 4) and ratings (Phase 5); none by default.
  beforeEach(() => {
    server.use(
      http.get(`${PROXY}/commerce/prices`, () => HttpResponse.json({ items: [] })),
      http.get(`${PROXY}/engagement/ratings`, () => HttpResponse.json({ items: [] })),
    );
  });

  it('shows the star ratings: page one from the server, later pages in one batch each', async () => {
    const user = userEvent.setup();
    const ratingRequests: string[] = [];
    const card = (n: number) => coursePage(n, 1, null).items[0]!.id;
    const rating = (courseId: string, average: string) => ({
      courseId,
      average,
      count: 1,
      histogram: {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': average === '4.0' ? 1 : 0,
        '5': average === '5.0' ? 1 : 0,
      },
    });
    server.use(
      http.get(`${PROXY}/catalog/courses`, () => HttpResponse.json(coursePage(3, 2, null))),
      http.get(`${PROXY}/engagement/ratings`, ({ request }) => {
        ratingRequests.push(new URL(request.url).searchParams.get('courseIds')!);
        return HttpResponse.json({ items: [rating(card(4), '4.0')] });
      }),
    );
    renderWithQuery(
      <BrowseResults
        filters={{}}
        initialPage={coursePage(1, 2, CURSOR_PAGE_2)}
        initialRatings={{ [card(1)]: rating(card(1), '5.0') }}
        limit={2}
      />,
    );
    const stars = () =>
      screen
        .getAllByTestId('course-rating')
        .map((r) => r.querySelector('[role=img]')!.getAttribute('aria-label'));
    expect(stars()).toEqual(['Rated 5 out of 5']);
    await user.click(screen.getByRole('button', { name: 'Load more courses' }));
    await waitFor(() => expect(stars()).toEqual(['Rated 5 out of 5', 'Rated 4 out of 5']));
    expect(ratingRequests).toEqual([`${card(3)},${card(4)}`]);
  });

  it('shows the prices: page one from the server, later pages in one batch each', async () => {
    const user = userEvent.setup();
    const priceRequests: string[] = [];
    const card = (n: number) => coursePage(n, 1, null).items[0]!.id;
    server.use(
      http.get(`${PROXY}/catalog/courses`, () => HttpResponse.json(coursePage(3, 2, null))),
      http.get(`${PROXY}/commerce/prices`, ({ request }) => {
        priceRequests.push(new URL(request.url).searchParams.get('courseIds')!);
        return HttpResponse.json({
          items: [
            {
              courseId: card(3),
              amount: '0.00',
              currency: 'USD',
              isFree: true,
              slug: 'a-course',
              title: 'A course',
            },
          ],
        });
      }),
    );
    renderWithQuery(
      <BrowseResults
        filters={{}}
        initialPage={coursePage(1, 2, CURSOR_PAGE_2)}
        initialPrices={{
          [card(1)]: {
            courseId: card(1),
            amount: '19.99',
            currency: 'USD',
            isFree: false,
            slug: 'a-course',
            title: 'A course',
          },
        }}
        limit={2}
      />,
    );
    const prices = () => screen.getAllByTestId('price').map((p) => p.textContent);
    expect(prices()).toEqual(['$19.99', 'Not available yet']);
    expect(priceRequests).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Load more courses' }));
    await waitFor(() =>
      expect(prices()).toEqual(['$19.99', 'Not available yet', 'Free', 'Not available yet']),
    );
    expect(priceRequests).toEqual([`${card(3)},${card(4)}`]);
  });

  it('shows no price line when the prices could not be loaded', () => {
    renderWithQuery(<BrowseResults filters={{}} initialPage={coursePage(1, 2, null)} limit={2} />);
    expect(screen.queryAllByTestId('price')).toEqual([]);
  });

  it('renders the server page, then loads the next keyset page with the exact cursor', async () => {
    const user = userEvent.setup();
    const requests: URL[] = [];
    server.use(
      http.get(`${PROXY}/catalog/courses`, ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        return HttpResponse.json(coursePage(3, 2, null));
      }),
    );

    renderWithQuery(
      <BrowseResults
        filters={{ category: 'design', level: 'BEGINNER' }}
        initialPage={coursePage(1, 2, CURSOR_PAGE_2)}
        limit={2}
      />,
    );
    expect(screen.getAllByTestId('course-card')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('Showing 2 courses');
    // The server already rendered page one: no request on mount.
    expect(requests).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Load more courses' }));
    await waitFor(() => expect(screen.getAllByTestId('course-card')).toHaveLength(4));

    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      category: 'design',
      level: 'BEGINNER',
      cursor: CURSOR_PAGE_2,
      limit: '2',
    });
    expect(screen.getByRole('status').textContent).toBe('Showing 4 courses');
    // nextCursor null: the end of the list.
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      '/course/course-1',
      '/course/course-2',
      '/course/course-3',
      '/course/course-4',
    ]);
  });

  it('shows an error and a retry when a page fails to load', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(`${PROXY}/catalog/courses`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              {
                type: 'about:blank',
                title: 'Unavailable',
                status: 503,
                code: 'service_unavailable',
              },
              { status: 503, headers: { 'content-type': 'application/problem+json' } },
            )
          : HttpResponse.json(coursePage(3, 1, null));
      }),
    );
    renderWithQuery(
      <BrowseResults filters={{}} initialPage={coursePage(1, 2, CURSOR_PAGE_2)} limit={2} />,
    );

    await user.click(screen.getByRole('button', { name: 'Load more courses' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByTestId('course-card')).toHaveLength(3));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
