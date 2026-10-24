// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeRealtimeTicket } from '@udemy/contracts/testing';
import { RealtimeClient, RealtimeProvider, type RealtimeSocket } from '@udemy/web-realtime';

import { asStudent, COURSE, enrollStudent, installLearning } from '@/test/learning';
import { setupMockApi } from '@/test/msw';
import { renderWithClient } from '@/test/render';

import { NotificationBell } from './notification-bell';

setupMockApi();

function seedQuestions(count: number) {
  const store = installLearning();
  enrollStudent(store);
  asStudent(store, () => {
    for (let i = 1; i <= count; i++) {
      store.askQuestion(COURSE, {
        title: `How do generics work, part ${i}?`,
        bodyMd: 'I am confused by **generics**.',
      });
    }
  });
  return store;
}

describe('<NotificationBell>', () => {
  it('shows the unread count and lists the newest notifications with links', async () => {
    seedQuestions(2);
    const user = userEvent.setup();
    renderWithClient(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    await user.click(bell);
    expect(bell.getAttribute('aria-expanded')).toBe('true');

    const list = await screen.findByRole('list', { name: 'Notification list' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('New question in Complete TypeScript');
    expect(rows[0]!.textContent).toContain('Jane Student asked “How do generics work, part 2?”');
    expect(rows[0]!.getAttribute('href')).toBe(`/qa?courseId=${COURSE}&status=unanswered`);
  });

  it('marks a row read when it is opened', async () => {
    const store = seedQuestions(1);
    const user = userEvent.setup();
    renderWithClient(<NotificationBell />);
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('link', { name: /New question/ });
    expect(link.textContent).toContain('(unread)');
    fireEvent.click(link);

    await waitFor(() => expect(store.unreadCount().count).toBe(0));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('marks everything read up to the newest row, and filters unread only', async () => {
    const store = seedQuestions(3);
    const user = userEvent.setup();
    renderWithClient(<NotificationBell />);
    await user.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
    await screen.findByRole('list', { name: 'Notification list' });

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(store.unreadCount().count).toBe(0));
    expect(
      (screen.getByRole('button', { name: 'Mark all as read' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByLabelText('Unread only'));
    expect(await screen.findByText('No unread notifications.')).toBeTruthy();

    // Escape still closes once focus left the panel (the disabled button dropped it).
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('No unread notifications.')).toBeNull();
  });

  it('pages with Load more', async () => {
    seedQuestions(12);
    const user = userEvent.setup();
    renderWithClient(<NotificationBell />);
    await user.click(await screen.findByRole('button', { name: /Notifications, 12 unread/ }));
    const list = await screen.findByRole('list', { name: 'Notification list' });
    expect(within(list).getAllByRole('link')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(12));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('closes on Escape and returns focus to the bell', async () => {
    installLearning();
    const user = userEvent.setup();
    renderWithClient(<NotificationBell />);
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    await user.click(bell);
    expect(await screen.findByText('No notifications yet.')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('No notifications yet.')).toBeNull();
    expect(document.activeElement).toBe(bell);
  });
});

/** A socket.io stand-in: `fire` plays a server event on the registered handlers. */
function fakeRealtime() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket: RealtimeSocket = {
    connected: false,
    on: (event, fn) => handlers.set(event, fn),
    emit: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
  };
  const client = new RealtimeClient({
    fetchTicket: async () => makeRealtimeTicket(),
    createSocket: () => socket,
  });
  const fire = (event: string, ...args: unknown[]) => {
    if (event === 'connect') socket.connected = true;
    handlers.get(event)?.(...args);
  };
  return { client, fire, ready: () => handlers.has('connect') };
}

describe('<NotificationBell> with the realtime socket', () => {
  it('refreshes the unread count on notification.created (no polling needed)', async () => {
    const store = installLearning();
    enrollStudent(store);
    const realtime = fakeRealtime();
    renderWithClient(
      <RealtimeProvider enabled client={realtime.client}>
        <NotificationBell />
      </RealtimeProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
    await waitFor(() => expect(realtime.ready()).toBe(true));
    realtime.fire('connect');

    asStudent(store, () =>
      store.askQuestion(COURSE, { title: 'Realtime question?', bodyMd: 'Is it live?' }),
    );
    const pushed = store.realtimeEvents.find((e) => e.event === 'notification.created')!;
    realtime.fire('notification.created', pushed.payload);

    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
  });
});
