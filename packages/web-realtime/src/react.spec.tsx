/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type RealtimeSocketOptions } from './client';
import {
  RealtimeProvider,
  useCourseRoom,
  useLiveRefetchInterval,
  useRealtimeStatus,
} from './react';

const COURSE = '0199c9a1-7d2e-7c4a-9b1e-000000000001';

afterEach(() => cleanup());

function fakeClient() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const emitted: string[] = [];
  const socket = {
    connected: false,
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, fn);
    },
    emit(event: string) {
      emitted.push(event);
    },
    connect() {},
    disconnect: vi.fn(),
  };
  let options: RealtimeSocketOptions | null = null;
  const client = new RealtimeClient({
    fetchTicket: async () => ({
      ticket: 'A'.repeat(43),
      url: 'http://127.0.0.1:3001',
      expiresAt: '2026-10-10T12:00:30.000Z',
    }),
    createSocket: (_url, opts) => {
      options = opts;
      return socket;
    },
  });
  const fire = (event: string, ...args: unknown[]) => {
    if (event === 'connect') socket.connected = true;
    handlers.get(event)?.(...args);
  };
  return { client, fire, emitted, socket, opened: () => options !== null };
}

function Probe() {
  const status = useRealtimeStatus();
  const interval = useLiveRefetchInterval(30_000);
  useCourseRoom(COURSE);
  return (
    <p data-testid="probe">
      {status}:{String(interval)}
    </p>
  );
}

function wrap(children: ReactNode, queryClient = new QueryClient()) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('<RealtimeProvider>', () => {
  it('is disabled (polling) when realtime is off', () => {
    render(wrap(<RealtimeProvider enabled={false}>{<Probe />}</RealtimeProvider>));
    expect(screen.getByTestId('probe').textContent).toBe('disabled:30000');
  });

  it('starts the client, stops polling while connected, joins the room and invalidates queries', async () => {
    const fake = fakeClient();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const view = render(
      wrap(
        <RealtimeProvider enabled client={fake.client}>
          <Probe />
        </RealtimeProvider>,
        queryClient,
      ),
    );
    await vi.waitFor(() => expect(fake.opened()).toBe(true));
    expect(screen.getByTestId('probe').textContent).toBe('connecting:30000');
    act(() => fake.fire('connect'));
    expect(screen.getByTestId('probe').textContent).toBe('connected:false');
    expect(fake.emitted).toContain('subscribe');

    act(() => fake.fire('qa.changed', { courseId: COURSE, questionId: COURSE, lectureId: null }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['qa', COURSE] });
    act(() => fake.fire('notification.unread', { count: 2 }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] });

    view.unmount();
    expect(fake.client.status).toBe('stopped');
    expect(fake.socket.disconnect).toHaveBeenCalled();
  });
});
