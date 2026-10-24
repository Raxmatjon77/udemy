/** @vitest-environment jsdom */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_IDS, type LearningMockStore } from '@udemy/contracts/testing';
import {
  RealtimeClient,
  RealtimeProvider,
  type RealtimeSocket,
  type RealtimeSocketOptions,
} from '@udemy/web-realtime';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asViewer, mockLearning } from '@/test/learning';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { HeaderNotifications } from './header-notifications';
import { NotificationPreferencesForm } from './notification-preferences';
import { Unsubscribe } from './unsubscribe';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Radix Popover measures its anchor (ResizeObserver), which jsdom lacks.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const server = setupMswServer();
const { course, student, instructor } = FIXTURE_IDS;

/** The instructor answers the student's question: the mock worker notifies the student. */
function answerNotification(store: LearningMockStore) {
  const question = store.askQuestion(course, { title: 'Why is const mutable?', bodyMd: 'Arrays?' });
  asViewer(store, { userId: instructor, app: 'instructor' }, () =>
    store.postAnswer(course, question.id, 'It freezes the binding.'),
  );
}

function enrolledStore(): LearningMockStore {
  const store = mockLearning(server);
  store.commerce.seedEnrollment(student, course);
  return store;
}

/** A socket.io stand-in the test drives (server → client events). */
class FakeSocket implements RealtimeSocket {
  connected = false;
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor(
    readonly url: string,
    readonly options: RealtimeSocketOptions,
  ) {}
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit() {
    return this;
  }
  connect() {
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  serverSends(event: string, payload: unknown = undefined) {
    if (event === 'connect') this.connected = true;
    for (const fn of this.handlers.get(event) ?? []) fn(payload);
  }
}

describe('<HeaderNotifications>', () => {
  it('shows the unread count, lists notifications and marks them read', async () => {
    const user = userEvent.setup();
    const store = enrolledStore();
    answerNotification(store);
    renderWithQuery(<HeaderNotifications />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
    await user.click(bell);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const item = await within(panel).findByTestId('notification');
    expect(item.textContent).toContain('New answer');
    expect(item.textContent).toContain(
      'The instructor answered “Why is const mutable?” in Complete TypeScript.',
    );
    expect(within(item).getByRole('link').getAttribute('href')).toBe(`/learn/${course}`);
    expect(item.getAttribute('data-unread')).toBe('true');

    await user.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy());
    expect(store.unreadCount()).toEqual({ count: 0, capped: false });
  });

  it('shows "99+" when the server caps the count', async () => {
    mockLearning(server);
    server.use(
      http.get(`${PROXY}/me/notifications/unread-count`, () =>
        HttpResponse.json({ count: 100, capped: true }),
      ),
    );
    renderWithQuery(<HeaderNotifications />);
    expect(
      await screen.findByRole('button', { name: 'Notifications, more than 99 unread' }),
    ).toBeTruthy();
    expect(screen.getByTestId('notification-badge').textContent).toBe('99+');
  });

  it('refreshes live from realtime hints (ticket from the BFF, websocket only)', async () => {
    const store = enrolledStore();
    let ticketCalls = 0;
    server.use(
      http.post('http://localhost:3000/api/realtime/ticket', () => {
        ticketCalls += 1;
        return HttpResponse.json(store.issueRealtimeTicket(), { status: 201 });
      }),
    );
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient({
      createSocket: (url, options) => {
        const socket = new FakeSocket(url, options);
        sockets.push(socket);
        return socket;
      },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <RealtimeProvider enabled client={client}>
          {children}
        </RealtimeProvider>
      );
    }
    renderWithQuery(
      <Wrapper>
        <HeaderNotifications />
      </Wrapper>,
    );
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    expect(ticketCalls).toBe(1);
    expect(socket.url).toBe('http://127.0.0.1:3001');
    expect(socket.options).toMatchObject({
      path: '/realtime/socket.io',
      transports: ['websocket'],
      auth: { ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
    });
    act(() => socket.serverSends('connect'));

    // The worker inserts a row and pushes the hint; the bell refetches over REST.
    store.realtimeEvents.length = 0;
    answerNotification(store);
    const created = store.realtimeEvents.find((e) => e.event === 'notification.created')!;
    act(() => socket.serverSends(created.event, created.payload));
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
    client.stop();
  });
});

describe('<NotificationPreferencesForm>', () => {
  it('shows the student categories × channels and saves a change at once; moderation is locked', async () => {
    const user = userEvent.setup();
    const store = mockLearning(server);
    renderWithQuery(<NotificationPreferencesForm />);

    const rows = await screen.findAllByRole('row');
    expect(rows.slice(1).map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Questions & answers',
      'Reviews',
      'Course announcements',
      'Learning (certificates)',
      'Moderation',
    ]);
    const email = screen.getByRole('checkbox', { name: 'Course announcements: Email' });
    expect(email).toHaveProperty('checked', true);
    await user.click(email);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'));
    expect(
      store.preferencesOf().find((p) => p.category === 'ANNOUNCEMENTS' && p.channel === 'EMAIL'),
    ).toMatchObject({ enabled: false, isDefault: false });
    expect(screen.getByRole('checkbox', { name: 'Moderation: Email' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('<Unsubscribe>', () => {
  it('POSTs the #token once, removes it from the URL and confirms', async () => {
    const store = mockLearning(server);
    const token = store.unsubscribeToken(student, 'ANNOUNCEMENTS');
    window.history.replaceState(null, '', `/unsubscribe#token=${encodeURIComponent(token)}`);
    renderWithQuery(<Unsubscribe />);
    expect(await screen.findByRole('heading', { name: 'You are unsubscribed' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(
      store
        .preferencesOf(student)
        .find((p) => p.category === 'ANNOUNCEMENTS' && p.channel === 'EMAIL'),
    ).toMatchObject({ enabled: false });
  });

  it('explains an invalid or missing token', async () => {
    mockLearning(server);
    window.history.replaceState(null, '', '/unsubscribe#token=v1.forged');
    const { unmount } = renderWithQuery(<Unsubscribe />);
    expect(await screen.findByRole('heading', { name: 'This link does not work' })).toBeTruthy();
    unmount();

    window.history.replaceState(null, '', '/unsubscribe');
    renderWithQuery(<Unsubscribe />);
    expect(await screen.findByRole('heading', { name: 'This link does not work' })).toBeTruthy();
  });
});
