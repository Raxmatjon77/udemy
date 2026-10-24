// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installLearning, seedReportedReview } from '@/test/learning';
import { setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { NotificationBell } from './notification-bell';

setupMockApi();

describe('<NotificationBell>', () => {
  it('shows MODERATION_QUEUE rows linking to the filtered queue, and marks them read', async () => {
    const store = installLearning();
    seedReportedReview(store, 3);
    const { user } = renderWithClient(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(bell);
    const list = await screen.findByRole('list', { name: 'Notification list' });
    const [row] = within(list).getAllByRole('link');
    expect(row!.textContent).toContain('A review was hidden automatically');
    expect(row!.textContent).toContain('3 open reports');
    expect(row!.getAttribute('href')).toBe('/moderation?type=REVIEW');

    fireEvent.click(row!);
    await waitFor(() => expect(store.unreadCount().count).toBe(0));
  });

  it('marks all as read and closes on Escape', async () => {
    const store = installLearning();
    seedReportedReview(store, 3);
    const { user } = renderWithClient(<NotificationBell />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(bell);
    await screen.findByRole('list', { name: 'Notification list' });
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(store.unreadCount().count).toBe(0));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Notification list' })).toBeNull();
    expect(document.activeElement).toBe(bell);
  });
});
