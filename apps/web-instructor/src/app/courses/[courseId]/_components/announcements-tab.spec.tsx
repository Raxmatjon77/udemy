// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { LearningMockStore } from '@udemy/contracts/testing';

import { courseDetail } from '@/test/fixtures';
import { COURSE, enrollStudent, installLearning } from '@/test/learning';
import { problem, proxy, server, setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { announcementRetryAt, AnnouncementsTab } from './announcements-tab';

setupMockApi();

const published = () => courseDetail({ id: COURSE, status: 'PUBLISHED', badge: 'LIVE' });

function post(store: LearningMockStore, n: number) {
  store.postAnnouncement(COURSE, {
    title: `Update number ${n}`,
    bodyMd: `New **lessons** (${n}).`,
    sendEmail: n % 2 === 0,
  });
}

function setup(options: { posted?: number; course?: ReturnType<typeof courseDetail> } = {}) {
  const store = installLearning();
  enrollStudent(store);
  for (let n = 1; n <= (options.posted ?? 0); n++) post(store, n);
  const user = userEvent.setup();
  renderWithClient(<AnnouncementsTab course={options.course ?? published()} />);
  return { store, user };
}

describe('<AnnouncementsTab>', () => {
  it('shows the quota left and the posted announcements', async () => {
    setup({ posted: 2 });
    expect(
      await screen.findByText('2 of 4 announcements used in the last 30 days. 2 left.'),
    ).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Posted announcements' });
    const item = within(list).getByRole('listitem', { name: 'Update number 2' });
    expect(within(item).getByText('Emailed')).toBeTruthy();
    expect(within(item).getByText('lessons')).toBeTruthy();
  });

  it('posts an announcement with a markdown body and the email option', async () => {
    const { store, user } = setup();
    const form = await screen.findByRole('form', { name: 'New announcement' });
    await user.click(within(form).getByRole('button', { name: 'Post announcement' }));
    expect(within(form).getAllByText(/at least|required/i).length).toBeGreaterThan(0);

    await user.type(within(form).getByLabelText('Title'), 'Section 6 is live');
    await user.type(within(form).getByLabelText('Message'), 'Watch the **new** videos.');
    await user.click(within(form).getByLabelText(/Also email it/));
    await user.click(within(form).getByRole('button', { name: 'Post announcement' }));

    expect(await within(form).findByText('Posted “Section 6 is live”.')).toBeTruthy();
    expect(await screen.findByRole('listitem', { name: 'Section 6 is live' })).toBeTruthy();
    expect(
      await screen.findByText('1 of 4 announcements used in the last 30 days. 3 left.'),
    ).toBeTruthy();
    const [posted] = store.instructorAnnouncements(COURSE);
    expect(posted).toMatchObject({ title: 'Section 6 is live', sendEmail: true });
    // The enrolled student was notified.
    expect(store.realtimeEvents.some((e) => e.event === 'notification.created')).toBe(true);
  });

  it('hides the form at the limit and says when the next post is allowed', async () => {
    setup({ posted: 4 });
    expect(await screen.findByText('Announcement limit reached')).toBeTruthy();
    expect(screen.getByText(/4 of 4 announcements used/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New announcement' })).toBeNull();
  });

  it('explains a 422 announcement_limit_exceeded with its retryAt', async () => {
    const { user } = setup({ posted: 3 });
    server.use(
      http.post(proxy(`/courses/${COURSE}/announcements`), () =>
        problem(422, 'announcement_limit_exceeded', { retryAt: '2026-11-20T09:30:00.000Z' }),
      ),
    );
    const form = await screen.findByRole('form', { name: 'New announcement' });
    await user.type(within(form).getByLabelText('Title'), 'One more update');
    await user.type(within(form).getByLabelText('Message'), 'Hello again.');
    await user.click(within(form).getByRole('button', { name: 'Post announcement' }));
    expect(
      await within(form).findByText(
        /reached its limit of 4 announcements in 30 days\. You can post again on Nov 20, 2026/,
      ),
    ).toBeTruthy();
  });

  it('deletes an announcement after confirmation (it still counts toward the quota)', async () => {
    const { store, user } = setup({ posted: 1 });
    const item = await screen.findByRole('listitem', { name: 'Update number 1' });
    await user.click(
      within(item).getByRole('button', { name: 'Delete announcement “Update number 1”' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/still counts toward the limit/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete announcement' }));
    await waitFor(() => expect(store.instructorAnnouncements(COURSE)).toHaveLength(0));
    expect(await screen.findByText('No announcements yet.')).toBeTruthy();
    expect(screen.getByText('1 of 4 announcements used in the last 30 days. 3 left.')).toBeTruthy();
  });

  it('does not offer posting before the course is published', async () => {
    setup({ course: courseDetail({ id: COURSE, status: 'DRAFT' }) });
    expect(
      await screen.findByText('You can post announcements once the course is published.'),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New announcement' })).toBeNull();
  });
});

describe('announcementRetryAt', () => {
  it('reads retryAt from an announcement_limit_exceeded problem only', async () => {
    const { ProxyFetchError } = await import('@udemy/web-auth/client');
    const limit = new ProxyFetchError(422, {
      type: 'about:blank',
      title: 'x',
      status: 422,
      code: 'announcement_limit_exceeded',
      retryAt: '2026-11-20T09:30:00.000Z',
    });
    expect(announcementRetryAt(limit)).toBe('2026-11-20T09:30:00.000Z');
    const other = new ProxyFetchError(422, { type: 'about:blank', title: 'x', status: 422 });
    expect(announcementRetryAt(other)).toBeNull();
    expect(announcementRetryAt(new Error('x'))).toBeNull();
  });
});
