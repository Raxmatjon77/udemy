/** @vitest-environment jsdom */
import { ErrorCode } from '@udemy/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useEffect } from 'react';
import type { HlsPlayerError } from '@udemy/ui/components/hls-player';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCourseRating, makePublicReview, fixtureId } from '@udemy/contracts/testing';

import {
  ARTICLE_PREVIEW_ID,
  COURSE_ID,
  courseLanding,
  LOCKED_VIDEO_ID,
  previewArticle,
  VIDEO_PREVIEW_ID,
} from '@/test/fixtures/catalog';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { CourseLandingView } from './course-landing';

// The PurchaseBox (Phase 4) is a client island with a router; its own spec covers it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

/** A signed-out visitor of a course without a price (the PurchaseBox shows "not for sale"). */
const GUEST = { price: null, signedIn: false } as const;

/** What the fake player reports on mount (a refused master playlist), or null. */
const playerOutcome: { error: HlsPlayerError | null } = { error: null };
beforeEach(() => {
  playerOutcome.error = null;
});

// jsdom has no MediaSource/HLS; the player itself is tested in @udemy/ui. Assert what it gets.
vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: function FakePlayer(props: {
    src: string;
    poster?: string;
    title: string;
    onError?: (error: HlsPlayerError) => void;
  }) {
    useEffect(() => {
      if (playerOutcome.error) props.onError?.(playerOutcome.error);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the player
    }, []);
    return (
      <div data-testid="hls-player" data-src={props.src} data-poster={props.poster}>
        {props.title}
      </div>
    );
  },
}));

const server = setupMswServer();

// Phase 5 islands: the public reviews and (signed in) the wishlist state. None by default.
beforeEach(() => {
  server.use(
    http.get(`${PROXY}/engagement/courses/:courseId/reviews`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${PROXY}/me/wishlist/states`, () =>
      HttpResponse.json({ items: [{ courseId: COURSE_ID, wishlisted: false }] }),
    ),
  );
});

describe('<CourseLandingView>', () => {
  it('renders the course header, outcomes, requirements and the sanitized description', () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Modern TypeScript </script> & more',
    );
    expect(screen.getByText('From the type system to production-grade Node services')).toBeTruthy();
    const facts = screen.getByText('Level:').closest('dl')!;
    expect(within(facts).getByText('Intermediate')).toBeTruthy();
    expect(within(facts).getByText('English')).toBeTruthy();
    expect(within(facts).getByText('Oct 5, 2026')).toBeTruthy();

    const outcomes = screen.getByRole('region', { name: "What you'll learn" });
    expect(
      within(outcomes)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Model domains with types', 'Write safe generics']);
    expect(screen.getByRole('region', { name: 'Requirements' }).textContent).toContain(
      'Basic JavaScript',
    );
    // MarkdownView shifts `#` to h3 (the page owns h1/h2).
    const description = screen.getByRole('region', { name: 'Description' });
    expect(within(description).getByRole('heading', { level: 3 }).textContent).toBe('Overview');
    expect(within(description).getByText('TypeScript').tagName).toBe('STRONG');

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(breadcrumb)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/courses', '/categories/development']);
  });

  it('shows the curriculum totals, per-section totals and lecture durations', () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    expect(screen.getByTestId('curriculum-totals').textContent).toBe(
      '2 sections · 4 lectures · 1h 06m total length',
    );
    const sections = screen.getAllByRole('group');
    expect(sections).toHaveLength(2);
    expect(sections[0]!.querySelector('summary')!.textContent).toContain('2 lectures · 4m');
    expect(sections[1]!.querySelector('summary')!.textContent).toContain('2 lectures · 1h 02m');
    const rows = screen.getAllByTestId('lecture-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Video:Welcome (free preview, opens a player)Preview4:054 minutes 5 seconds',
      'Article:Course notes (free preview, opens a player)Preview',
      'Video:Generics1:02:031 hour 2 minutes 3 seconds',
      'Resource:Cheat sheet',
    ]);
  });

  it('marks only preview lectures with a Preview badge and button', () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    expect(screen.getAllByText('Preview', { selector: '[data-slot="badge"]' })).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: /free preview/ }).map((b) => b.textContent),
    ).toEqual([
      'Welcome (free preview, opens a player)',
      'Course notes (free preview, opens a player)',
    ]);
    expect(screen.queryByRole('button', { name: /Generics/ })).toBeNull();
  });

  it('shows the instructor card, and hides it when the API hides the instructor', () => {
    const { unmount } = renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    expect(within(screen.getByTestId('instructor-card')).getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText(/Created by/)).toBeTruthy();
    unmount();

    renderWithQuery(<CourseLandingView landing={courseLanding({ instructor: null })} {...GUEST} />);
    expect(screen.queryByTestId('instructor-card')).toBeNull();
    expect(screen.queryByText(/Created by/)).toBeNull();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('puts the PurchaseBox in the enrollment aside, or says the price could not be loaded', () => {
    const { unmount } = renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    const aside = screen.getByRole('complementary', { name: 'Enrollment' });
    expect(within(aside).getByTestId('purchase-box').dataset.state).toBe('not_for_sale');
    unmount();

    renderWithQuery(
      <CourseLandingView landing={courseLanding()} price={undefined} signedIn={false} />,
    );
    const cta = screen.getByRole('button', { name: 'Enrollment unavailable' }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(screen.queryByTestId('purchase-box')).toBeNull();
  });
});

describe('preview modal', () => {
  it('plays a video preview from the public master playlist through the BFF', async () => {
    const user = userEvent.setup();
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);

    const trigger = screen.getByRole('button', { name: /^Welcome/ });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Welcome' });
    const player = within(dialog).getByTestId('hls-player');
    expect(player.getAttribute('data-src')).toBe(
      `/api/proxy/catalog/courses/${COURSE_ID}/lectures/${VIDEO_PREVIEW_ID}/hls/master.m3u8`,
    );
    expect(player.getAttribute('data-poster')).toBe(
      `/media/course-thumbnail/${COURSE_ID}?variant=w750`,
    );

    // Keyboard: Escape closes, focus returns to the lecture's button.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders an article preview with the sanitized MarkdownView', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${PROXY}/catalog/courses/${COURSE_ID}/lectures/${ARTICLE_PREVIEW_ID}/article`, () =>
        HttpResponse.json(previewArticle),
      ),
    );
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);

    await user.click(screen.getByRole('button', { name: /^Course notes/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Course notes' });
    const article = await within(dialog).findByTestId('article-preview');
    expect(within(article).getByRole('heading', { level: 3 }).textContent).toBe('Notes');
    expect(within(article).getByText('this').tagName).toBe('STRONG');
    // Raw HTML in the markdown is dropped, never rendered.
    expect(article.querySelector('img')).toBeNull();
    expect(within(dialog).queryByTestId('hls-player')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('requests no poster when the course has no thumbnail', async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <CourseLandingView landing={courseLanding({ hasThumbnail: false })} {...GUEST} />,
    );
    // The sidebar shows the placeholder without an image request.
    expect(document.querySelector('[data-slot="course-thumbnail"] img')).toBeNull();
    expect(document.querySelector('[data-slot="thumbnail-placeholder"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /^Welcome/ }));
    const player = within(await screen.findByRole('dialog')).getByTestId('hls-player');
    expect(player.hasAttribute('data-poster')).toBe(false);
  });

  it('renders the thumbnail image when the API says there is one', () => {
    renderWithQuery(
      <CourseLandingView landing={courseLanding({ hasThumbnail: true })} {...GUEST} />,
    );
    const img = document.querySelector('[data-slot="course-thumbnail"] img')!;
    const src = new URL(img.getAttribute('src')!, 'http://localhost:3000');
    expect(`${src.pathname}${src.search}`).toBe(
      `/media/course-thumbnail/${COURSE_ID}?variant=w750`,
    );
  });

  it('explains a 403 lecture_locked playlist instead of a generic player error', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        `${PROXY}/catalog/courses/${COURSE_ID}/lectures/${VIDEO_PREVIEW_ID}/hls/master.m3u8`,
        () =>
          HttpResponse.json(
            { type: 'about:blank', title: 'Forbidden', status: 403, code: ErrorCode.LectureLocked },
            { status: 403, headers: { 'content-type': 'application/problem+json' } },
          ),
      ),
    );
    playerOutcome.error = { reason: 'forbidden', httpStatus: 403 };
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    await user.click(screen.getByRole('button', { name: /^Welcome/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId('playback-problem').textContent).toBe(
        'This lecture is not available as a free preview.',
      ),
    );
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('explains a 429 on the playlist with the Retry-After wait', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${PROXY}/catalog/courses/:courseId/lectures/:lectureId/hls/master.m3u8`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Too Many Requests', status: 429, code: 'rate_limited' },
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '30' },
          },
        ),
      ),
    );
    playerOutcome.error = { reason: 'network', httpStatus: 429 };
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    await user.click(screen.getByRole('button', { name: /^Welcome/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId('playback-problem').textContent).toContain(
        'Too many playback requests. Try again in 30 seconds.',
      ),
    );
    expect(
      (within(dialog).getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers no preview (and no download) for a RESOURCE lecture', () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    expect(screen.queryByRole('button', { name: /^Cheat sheet/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });

  it('opens non-preview lectures for an enrolled student, and only then', async () => {
    const user = userEvent.setup();
    let enrolled = true;
    server.use(
      http.get(`${PROXY}/me/purchase-states`, () =>
        HttpResponse.json({
          items: [{ courseId: COURSE_ID, enrolled, inCart: false, isOwner: false, forSale: true }],
        }),
      ),
    );
    const { unmount } = renderWithQuery(
      <CourseLandingView landing={courseLanding()} price={null} signedIn />,
    );
    await user.click(screen.getByRole('button', { name: 'Expand all sections' }));
    await user.click(await screen.findByRole('button', { name: /^Generics/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^Lecture ·/)).toBeTruthy();
    expect(within(dialog).getByTestId('hls-player').dataset.src).toBe(
      `/api/proxy/catalog/courses/${COURSE_ID}/lectures/${LOCKED_VIDEO_ID}/hls/master.m3u8`,
    );
    // RESOURCE lectures still have no player here.
    expect(screen.queryByRole('button', { name: /^Cheat sheet/ })).toBeNull();
    unmount();

    enrolled = false;
    renderWithQuery(<CourseLandingView landing={courseLanding()} price={null} signedIn />);
    await user.click(screen.getByRole('button', { name: 'Expand all sections' }));
    await waitFor(() =>
      expect(screen.getByTestId('purchase-box').dataset.state).not.toBe('loading'),
    );
    expect(screen.queryByRole('button', { name: /^Generics/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Welcome/ })).toBeTruthy();
  });

  it('explains a locked article instead of failing', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${PROXY}/catalog/courses/:courseId/lectures/:lectureId/article`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Forbidden', status: 403, code: ErrorCode.LectureLocked },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    await user.click(screen.getByRole('button', { name: /^Course notes/ }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This lecture is not available as a free preview.',
    );
  });
});

describe('student feedback (Phase 5)', () => {
  const rating = makeCourseRating({
    courseId: COURSE_ID,
    histogram: { '1': 1, '2': 0, '3': 1, '4': 3, '5': 5 },
  });

  it('shows the rating summary in the header and the histogram', async () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} rating={rating} />);
    const header = screen.getByRole('region', { name: /Modern TypeScript/ });
    expect(within(header).getByTestId('course-rating').textContent).toBe('4.1(10 ratings)');
    const feedback = screen.getByRole('region', { name: 'Student feedback' });
    expect(within(feedback).getByRole('img', { name: 'Rated 4.1 out of 5' })).toBeTruthy();
    expect(
      within(feedback)
        .getAllByRole('button', { name: /star/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['5 stars: 50%', '4 stars: 30%', '3 stars: 10%', '2 stars: 0%', '1 star: 10%']);
    expect(await within(feedback).findByText('No reviews yet.')).toBeTruthy();
  });

  it('lists public reviews with keyset "Load more" and filters by stars', async () => {
    const user = userEvent.setup();
    const asked: { rating: string | null; cursor: string | null }[] = [];
    const page1 = [
      makePublicReview({ id: fixtureId(0x4e01), rating: 5, body: 'Superb </script> course' }),
      makePublicReview({
        id: fixtureId(0x4e02),
        rating: 4,
        body: 'Good',
        author: null,
        reply: {
          body: 'Thanks!',
          author: { id: fixtureId(0x1157), displayName: 'Ada Instructor' },
          createdAt: '2026-10-10T12:00:00.000Z',
          editedAt: null,
        },
      }),
    ];
    const page2 = [makePublicReview({ id: fixtureId(0x4e03), rating: 1, body: 'Meh' })];
    server.use(
      http.get(`${PROXY}/engagement/courses/${COURSE_ID}/reviews`, ({ request }) => {
        const url = new URL(request.url);
        const query = {
          rating: url.searchParams.get('rating'),
          cursor: url.searchParams.get('cursor'),
        };
        asked.push(query);
        if (query.rating === '1') return HttpResponse.json({ items: page2, nextCursor: null });
        return query.cursor
          ? HttpResponse.json({ items: page2, nextCursor: null })
          : HttpResponse.json({ items: page1, nextCursor: 'c2' });
      }),
    );
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} rating={rating} />);

    const reviews = await screen.findAllByTestId('review');
    expect(reviews).toHaveLength(2);
    // Plain text, never markup.
    expect(within(reviews[0]!).getByText('Superb </script> course')).toBeTruthy();
    expect(within(reviews[1]!).getByText('Former student')).toBeTruthy();
    expect(within(reviews[1]!).getByTestId('review-reply').textContent).toContain(
      'Response from Ada Instructor',
    );

    await user.click(screen.getByRole('button', { name: 'Load more reviews' }));
    await waitFor(() => expect(screen.getAllByTestId('review')).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: '1 star: 10%' }));
    await waitFor(() => expect(screen.getAllByTestId('review')).toHaveLength(1));
    expect(screen.getByRole('button', { name: '1 star: 10%' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(asked).toEqual([
      { rating: null, cursor: null },
      { rating: null, cursor: 'c2' },
      { rating: '1', cursor: null },
    ]);
  });

  it('a signed-in visitor can add the course to the wishlist (and remove it)', async () => {
    const user = userEvent.setup();
    const puts: string[] = [];
    let wishlisted = false;
    server.use(
      http.get(`${PROXY}/me/purchase-states`, () => HttpResponse.json({ items: [] })),
      http.get(`${PROXY}/me/wishlist/states`, () =>
        HttpResponse.json({ items: [{ courseId: COURSE_ID, wishlisted }] }),
      ),
      http.put(`${PROXY}/me/wishlist/:courseId`, ({ params }) => {
        puts.push(`PUT ${String(params.courseId)}`);
        wishlisted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${PROXY}/me/wishlist/:courseId`, ({ params }) => {
        puts.push(`DELETE ${String(params.courseId)}`);
        wishlisted = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithQuery(<CourseLandingView landing={courseLanding()} price={null} signedIn />);
    const heart = await screen.findByRole('button', { name: 'Add to wishlist' });
    expect(heart.getAttribute('aria-pressed')).toBe('false');
    await user.click(heart);
    const on = await screen.findByRole('button', { name: 'Wishlisted' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    await user.click(on);
    await screen.findByRole('button', { name: 'Add to wishlist' });
    expect(puts).toEqual([`PUT ${COURSE_ID}`, `DELETE ${COURSE_ID}`]);
  });

  it('explains why an owned or enrolled course cannot be wishlisted', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${PROXY}/me/purchase-states`, () => HttpResponse.json({ items: [] })),
      http.put(`${PROXY}/me/wishlist/:courseId`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: ErrorCode.CourseNotWishlistable,
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderWithQuery(<CourseLandingView landing={courseLanding()} price={null} signedIn />);
    await user.click(await screen.findByRole('button', { name: 'Add to wishlist' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You already have access to this course.',
    );
  });

  it('shows no wishlist button to signed-out visitors', async () => {
    renderWithQuery(<CourseLandingView landing={courseLanding()} {...GUEST} />);
    await screen.findByText('No reviews yet.');
    expect(screen.queryByRole('button', { name: 'Add to wishlist' })).toBeNull();
  });
});
