// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json, mockApi, problem } from '@/test/api-mock';
import { courseDetail, coursePage, courseRow, uuid } from '@/test/fixtures';
import { renderWithClient } from '@/test/render';

import { CoursesSearch } from './courses-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());

const ORIGIN = 'http://localhost:3000';

const live = courseRow(1, {
  title: 'Live course',
  owner: { id: uuid(8001), displayName: 'Banned Bob', banned: true },
});
const archived = courseRow(2, { title: 'Archived course', status: 'ARCHIVED', badge: 'ARCHIVED' });
const inReview = courseRow(3, {
  title: 'Draft in review',
  status: 'IN_REVIEW',
  badge: 'IN_REVIEW',
  pendingRevisionId: uuid(9999),
  liveRevisionId: null,
  firstPublishedAt: null,
});

const row = (title: string) => screen.getByText(title).closest('tr')!;

describe('<CoursesSearch>', () => {
  it('shows status, the owner-banned flag, public and review links, and the right actions', async () => {
    mockApi({ 'GET /admin/courses': () => json(coursePage([live, archived, inReview])) });
    renderWithClient(<CoursesSearch filters={{}} studentOrigin={ORIGIN} />);

    const liveRow = await screen.findByText('Live course').then((el) => el.closest('tr')!);
    expect(within(liveRow).getByText('Owner banned')).toBeTruthy();
    expect(within(liveRow).getByText('Live')).toBeTruthy();
    expect(
      within(liveRow)
        .getByRole('link', { name: /Public page/ })
        .getAttribute('href'),
    ).toBe(`${ORIGIN}/course/course-1`);
    expect(within(liveRow).getByRole('button', { name: 'Take down Live course' })).toBeTruthy();

    const archivedRow = row('Archived course');
    expect(within(archivedRow).queryByText('Owner banned')).toBeNull();
    expect(within(archivedRow).queryByRole('link', { name: /Public page/ })).toBeNull();
    expect(
      within(archivedRow).getByRole('button', { name: 'Restore Archived course' }),
    ).toBeTruthy();

    const reviewRow = row('Draft in review');
    expect(
      within(reviewRow).getByRole('link', { name: 'Review submission' }).getAttribute('href'),
    ).toBe(`/course-reviews/${uuid(9999)}`);
    expect(within(reviewRow).queryByRole('button')).toBeNull();
  });

  it('hides public links when the student origin is not configured', async () => {
    mockApi({ 'GET /admin/courses': () => json(coursePage([live])) });
    renderWithClient(<CoursesSearch filters={{}} studentOrigin={null} />);
    await screen.findByText('Live course');
    expect(screen.queryByRole('link', { name: /Public page/ })).toBeNull();
  });

  it('sends the filters and pages with the cursor', async () => {
    const api = mockApi({
      'GET /admin/courses': ({ query }) =>
        query.get('cursor') ? json(coursePage([archived])) : json(coursePage([live], 'next1')),
    });
    const { user } = renderWithClient(
      <CoursesSearch filters={{ q: 'typescript', status: 'PUBLISHED' }} studentOrigin={ORIGIN} />,
    );
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Archived course');
    expect(
      api.callsTo('GET', /^\/admin\/courses$/).map((c) => Object.fromEntries(c.query)),
    ).toEqual([
      { q: 'typescript', status: 'PUBLISHED', limit: '20' },
      { q: 'typescript', status: 'PUBLISHED', cursor: 'next1', limit: '20' },
    ]);
  });

  it('validates the search and navigates with the filters', async () => {
    mockApi({ 'GET /admin/courses': () => json(coursePage([])) });
    const { user } = renderWithClient(<CoursesSearch filters={{}} studentOrigin={ORIGIN} />);
    expect(await screen.findByText('No courses match these filters.')).toBeTruthy();

    await user.type(screen.getByLabelText('Title or slug'), 'ts');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/at least 3 characters/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Title or slug'), 'x');
    await user.selectOptions(screen.getByLabelText('Status'), 'ARCHIVED');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/courses?q=tsx&status=ARCHIVED'));
  });

  it('takes a course down with a required reason and refreshes the list', async () => {
    let takenDown = false;
    const api = mockApi({
      'GET /admin/courses': () =>
        json(coursePage([takenDown ? { ...live, status: 'ARCHIVED', badge: 'ARCHIVED' } : live])),
      'POST /admin/courses/:id/takedown': () => {
        takenDown = true;
        return json(courseDetail({ status: 'ARCHIVED', badge: 'ARCHIVED' }));
      },
    });
    const { user } = renderWithClient(<CoursesSearch filters={{}} studentOrigin={ORIGIN} />);
    await user.click(await screen.findByRole('button', { name: 'Take down Live course' }));

    const dialog = screen.getByRole('dialog', { name: 'Take down “Live course”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Take down course' }));
    expect(await within(dialog).findByText('Must be at least 10 characters.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Reason/), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Take down course' }));
    expect(within(dialog).getByText('Must be at least 10 characters.')).toBeTruthy();
    expect(api.callsTo('POST', /takedown$/)).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText(/Reason/));
    await user.type(within(dialog).getByLabelText(/Reason/), 'The instructor account was banned.');
    await user.click(within(dialog).getByRole('button', { name: 'Take down course' }));

    expect(await screen.findByText(/“Live course” was taken down/)).toBeTruthy();
    expect(api.callsTo('POST', /takedown$/)).toEqual([
      expect.objectContaining({
        path: `/admin/courses/${live.id}/takedown`,
        body: { reason: 'The instructor account was banned.' },
      }),
    ]);
    expect(await screen.findByRole('button', { name: 'Restore Live course' })).toBeTruthy();
  });

  it('restores an archived course after confirmation', async () => {
    const api = mockApi({
      'GET /admin/courses': () => json(coursePage([archived])),
      'POST /admin/courses/:id/restore': () => json(courseDetail()),
    });
    const { user } = renderWithClient(<CoursesSearch filters={{}} studentOrigin={ORIGIN} />);
    await user.click(await screen.findByRole('button', { name: 'Restore Archived course' }));
    await user.click(screen.getByRole('button', { name: 'Restore course' }));
    expect(await screen.findByText('“Archived course” is live again.')).toBeTruthy();
    expect(api.callsTo('POST', /restore$/)).toEqual([
      expect.objectContaining({ path: `/admin/courses/${archived.id}/restore`, body: undefined }),
    ]);
  });

  it('explains a stale takedown and refreshes the list', async () => {
    const api = mockApi({
      'GET /admin/courses': () => json(coursePage([live])),
      'POST /admin/courses/:id/takedown': () => problem(409, 'invalid_state_transition'),
    });
    const { user } = renderWithClient(<CoursesSearch filters={{}} studentOrigin={ORIGIN} />);
    await user.click(await screen.findByRole('button', { name: 'Take down Live course' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Breaks the content rules.');
    await user.click(within(dialog).getByRole('button', { name: 'Take down course' }));
    expect(await within(dialog).findByText(/The course changed in the meantime/)).toBeTruthy();
    await waitFor(() => expect(api.callsTo('GET', /^\/admin\/courses$/)).toHaveLength(2));
  });
});
