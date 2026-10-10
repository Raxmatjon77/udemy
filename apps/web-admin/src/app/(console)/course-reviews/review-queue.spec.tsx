// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json, mockApi, problem } from '@/test/api-mock';
import { queueItem, queuePage } from '@/test/fixtures';
import { renderWithClient } from '@/test/render';

import { ReviewQueue } from './review-queue';

describe('<ReviewQueue>', () => {
  it('lists pending revisions oldest first and pages with the keyset cursor', async () => {
    const api = mockApi({
      'GET /admin/course-reviews': ({ query }) =>
        query.get('cursor') === 'page2'
          ? json(queuePage([queueItem(3, { kind: 'UPDATE', revisionNo: 4 })], null))
          : json(queuePage([queueItem(1), queueItem(2)], 'page2')),
    });
    const { user } = renderWithClient(<ReviewQueue />);

    const first = await screen.findByRole('link', { name: 'Course number 1' });
    expect(first.getAttribute('href')).toBe(`/course-reviews/${queueItem(1).revisionId}`);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual([
      'Course number 1',
      'Course number 2',
    ]);
    expect(within(rows[0]!).getByText('Instructor 1')).toBeTruthy();
    expect(within(rows[0]!).getByText('New course')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing 2 submissions');

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    const third = await screen.findByRole('link', { name: 'Course number 3' });
    const thirdRow = third.closest('tr')!;
    expect(within(thirdRow).getByText('Update')).toBeTruthy();
    expect(within(thirdRow).getByText('Revision 4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Showing 3 submissions (all)');

    const requests = api.callsTo('GET', /^\/admin\/course-reviews$/);
    expect(requests.map((r) => [r.query.get('cursor'), r.query.get('limit')])).toEqual([
      [null, '20'],
      ['page2', '20'],
    ]);
  });

  it('shows an empty state', async () => {
    mockApi({ 'GET /admin/course-reviews': () => json(queuePage([], null)) });
    renderWithClient(<ReviewQueue />);
    expect(await screen.findByText(/Nothing to review/)).toBeTruthy();
  });

  it('keeps loaded rows when the next page fails, and retries it', async () => {
    let failNext = true;
    mockApi({
      'GET /admin/course-reviews': ({ query }) => {
        if (!query.get('cursor')) return json(queuePage([queueItem(1)], 'page2'));
        if (failNext) {
          failNext = false;
          return problem(503, 'service_unavailable');
        }
        return json(queuePage([queueItem(2)], null));
      },
    });
    const { user } = renderWithClient(<ReviewQueue />);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/);
    expect(screen.getByRole('link', { name: 'Course number 1' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Course number 2' })).toBeTruthy();
  });
});
