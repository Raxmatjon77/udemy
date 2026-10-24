import { REALTIME_SOCKET_PATH, type RealtimeTicket } from '@udemy/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRealtimeTicket,
  RealtimeClient,
  RealtimeTicketError,
  type RealtimeSocketOptions,
} from './client';

const COURSE = '0199c9a1-7d2e-7c4a-9b1e-000000000001';
const COURSE_2 = '0199c9a1-7d2e-7c4a-9b1e-000000000002';
const NOTIFICATION = '0199c9a1-7d2e-7c4a-9b1e-000000000003';
const URL_ = 'http://127.0.0.1:3001';

function ticketValue(n: number): string {
  return `T${String(n).padStart(42, '0')}`;
}

class FakeSocket {
  connected = false;
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emitted: { event: string; args: unknown[] }[] = [];
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  connect = vi.fn();
  constructor(
    readonly url: string,
    readonly options: RealtimeSocketOptions,
  ) {}
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

function setup(options: { ticket?: () => Promise<RealtimeTicket>; random?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  let issued = 0;
  const fetchTicket = vi.fn(
    options.ticket ??
      (async (): Promise<RealtimeTicket> => {
        issued += 1;
        return {
          ticket: ticketValue(issued),
          url: URL_,
          expiresAt: '2026-10-10T12:00:30.000Z',
        };
      }),
  );
  const onError = vi.fn();
  const client = new RealtimeClient({
    fetchTicket,
    createSocket: (url, opts) => {
      const socket = new FakeSocket(url, opts);
      sockets.push(socket);
      return socket;
    },
    backoff: { initialMs: 1000, maxMs: 8000 },
    random: options.random ?? (() => 0.5),
    onError,
  });
  const statuses: string[] = [];
  client.onStatus((s) => statuses.push(s));
  return { client, sockets, fetchTicket, onError, statuses, last: () => sockets.at(-1)! };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient', () => {
  it('connects with a ticket in the auth payload, websocket only, on the realtime path', async () => {
    const { client, last, statuses } = setup();
    client.start();
    expect(client.status).toBe('connecting');
    await flush();
    const socket = last();
    expect(socket.url).toBe(URL_);
    expect(socket.url).not.toContain(ticketValue(1));
    expect(socket.options).toEqual({
      path: REALTIME_SOCKET_PATH,
      transports: ['websocket'],
      auth: { ticket: ticketValue(1) },
      reconnection: false,
      autoConnect: true,
      withCredentials: false,
    });
    socket.fire('connect');
    expect(client.status).toBe('connected');
    expect(statuses).toEqual(['connecting', 'connected']);
    client.start(); // idempotent
    await flush();
    expect(client.status).toBe('connected');
  });

  it('backs off exponentially with a fresh ticket per attempt, and resets after a connect', async () => {
    const { client, sockets, fetchTicket, last } = setup({ random: () => 0.999 });
    client.start();
    await flush();
    last().fire('connect_error', new Error('ticket_invalid'));
    expect(client.status).toBe('reconnecting');
    expect(last().disconnect).toHaveBeenCalled();

    // attempt 1: ceiling 1000 ms -> delay 999
    await vi.advanceTimersByTimeAsync(998);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(last().options.auth.ticket).toBe(ticketValue(2));

    // attempt 2: ceiling 2000 ms -> 1998
    last().fire('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(1997);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTicket).toHaveBeenCalledTimes(3);

    // capped at maxMs (8000)
    for (const ceiling of [4000, 8000, 8000]) {
      last().fire('connect_error', new Error('too_many_connections'));
      await vi.advanceTimersByTimeAsync(Math.floor(0.999 * ceiling));
    }
    expect(fetchTicket).toHaveBeenCalledTimes(6);

    // a successful connect resets the attempt counter
    last().fire('connect');
    last().fire('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchTicket).toHaveBeenCalledTimes(7);
    expect(new Set(sockets.map((s) => s.options.auth.ticket)).size).toBe(7);
  });

  it('reconnects at once with a new ticket on session.reauth and on a server disconnect', async () => {
    const { client, fetchTicket, last } = setup();
    client.start();
    await flush();
    last().fire('connect');
    const first = last();
    first.fire('session.reauth', {});
    expect(client.status).toBe('reconnecting');
    expect(first.disconnect).toHaveBeenCalled();
    await flush();
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    last().fire('connect');
    last().fire('disconnect', 'io server disconnect');
    await flush();
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    expect(last().options.auth.ticket).toBe(ticketValue(3));
  });

  it('stops for good on session_revoked', async () => {
    const { client, fetchTicket, last } = setup();
    client.start();
    await flush();
    last().fire('connect_error', new Error('session_revoked'));
    expect(client.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
  });

  it('stops when the ticket route says 401, retries on 503', async () => {
    let status = 503;
    const { client, fetchTicket, onError } = setup({
      ticket: () => Promise.reject(new RealtimeTicketError(status)),
    });
    client.start();
    await flush();
    expect(client.status).toBe('reconnecting');
    status = 401;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(client.status).toBe('stopped');
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it('delivers validated payloads and drops invalid ones', async () => {
    const { client, last, onError } = setup();
    const created = vi.fn();
    const off = client.on('notification.created', created);
    client.start();
    await flush();
    last().fire('connect');
    last().fire('notification.created', {
      id: NOTIFICATION,
      kind: 'QA_NEW_ANSWER',
      app: 'STUDENT',
    });
    last().fire('notification.created', { id: 'nope', kind: 'QA_NEW_ANSWER', app: 'STUDENT' });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith({
      id: NOTIFICATION,
      kind: 'QA_NEW_ANSWER',
      app: 'STUDENT',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    last().fire('notification.created', {
      id: NOTIFICATION,
      kind: 'QA_NEW_ANSWER',
      app: 'STUDENT',
    });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('joins course rooms when connected, again after every reconnect, and leaves on the last release', async () => {
    const { client, last } = setup();
    const releaseA = client.subscribeCourse(COURSE);
    client.start();
    await flush();
    last().fire('connect');
    expect(last().emitted.map((e) => [e.event, e.args[0]])).toEqual([
      ['subscribe', { courseId: COURSE }],
    ]);
    const releaseB = client.subscribeCourse(COURSE); // ref-counted: no second emit
    client.subscribeCourse(COURSE_2);
    last().fire('session.reauth', {});
    await flush();
    last().fire('connect');
    expect(last().emitted.map((e) => [e.event, e.args[0]])).toEqual([
      ['subscribe', { courseId: COURSE }],
      ['subscribe', { courseId: COURSE_2 }],
    ]);
    releaseA();
    releaseA(); // idempotent
    expect(last().emitted).toHaveLength(2);
    releaseB();
    expect(last().emitted.at(-1)).toMatchObject({
      event: 'unsubscribe',
      args: [{ courseId: COURSE }, expect.any(Function)],
    });
  });

  it('stop() disconnects and cancels a pending retry', async () => {
    const { client, fetchTicket, last } = setup();
    client.start();
    await flush();
    last().fire('connect_error', new Error('ticket_invalid'));
    client.stop();
    expect(client.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    client.start(); // a stopped client can start again (React Strict Mode remounts)
    await flush();
    last().fire('connect');
    client.stop();
    expect(last().disconnect).toHaveBeenCalled();
    expect(client.status).toBe('stopped');
  });

  it('ignores a ticket that arrives after stop()', async () => {
    let resolve!: (t: RealtimeTicket) => void;
    const { client, sockets } = setup({
      ticket: () => new Promise<RealtimeTicket>((r) => (resolve = r)),
    });
    client.start();
    client.stop();
    resolve({ ticket: ticketValue(1), url: URL_, expiresAt: '2026-10-10T12:00:30.000Z' });
    await flush();
    expect(sockets).toHaveLength(0);
  });
});

describe('fetchRealtimeTicket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs same-origin and parses the ticket', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ticket: ticketValue(9), url: URL_, expiresAt: '2026-10-10T12:00:30.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchRealtimeTicket()).resolves.toMatchObject({ ticket: ticketValue(9) });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/realtime/ticket',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('throws RealtimeTicketError with the status', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
    await expect(fetchRealtimeTicket()).rejects.toMatchObject({ status: 401 });
  });
});
