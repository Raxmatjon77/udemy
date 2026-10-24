import {
  parseRealtimeServerEvent,
  REALTIME_SERVER_EVENTS,
  REALTIME_SOCKET_PATH,
  REALTIME_TRANSPORTS,
  RealtimeTicketSchema,
  type RealtimeServerEvent,
  type RealtimeServerEventPayload,
  type RealtimeTicket,
} from '@udemy/contracts';
import { io } from 'socket.io-client';

/**
 * Framework-free socket.io client of the realtime layer (Phase 5 design D15–D17, §10).
 *
 * - Every connection attempt uses a FRESH single-use ticket from the BFF (`POST
 *   /api/realtime/ticket`), sent in the handshake `auth` payload (never in the URL).
 * - WebSocket transport only; socket.io's own reconnection is off because a reconnect needs a
 *   new ticket. The client runs its own exponential backoff (full jitter), reset on connect.
 * - `session.reauth` or a server-side disconnect (the 15 min cap, `reauth_required`) reconnects
 *   at once with a new ticket. `session_revoked` (handshake) or a 401/403 from the ticket route
 *   stops the client: the session is over, retrying cannot help.
 * - Server messages are invalidation hints: payloads are validated with the contracts schemas and
 *   invalid ones are dropped.
 */

export type RealtimeStatus =
  'disabled' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** The BFF ticket route answered with a non-2xx status. */
export class RealtimeTicketError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Realtime ticket request failed with status ${status}`);
    this.name = 'RealtimeTicketError';
    this.status = status;
  }
}

export const DEFAULT_REALTIME_TICKET_PATH = '/api/realtime/ticket';

/** `POST /api/realtime/ticket` on this app's own origin, parsed with `RealtimeTicketSchema`. */
export async function fetchRealtimeTicket(
  path: string = DEFAULT_REALTIME_TICKET_PATH,
  init: { signal?: AbortSignal } = {},
): Promise<RealtimeTicket> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RealtimeTicketError(response.status);
  }
  return RealtimeTicketSchema.parse(await response.json());
}

/** The socket surface the client uses (socket.io-client's `Socket` satisfies it). */
export interface RealtimeSocket {
  connected: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io listener arity varies
  on(event: string, fn: (...args: any[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

export interface RealtimeSocketOptions {
  path: string;
  transports: string[];
  auth: { ticket: string };
  reconnection: false;
  autoConnect: boolean;
  withCredentials: false;
}

export type RealtimeSocketFactory = (url: string, options: RealtimeSocketOptions) => RealtimeSocket;

export interface RealtimeClientOptions {
  /** Default: `fetchRealtimeTicket()`. */
  fetchTicket?: () => Promise<RealtimeTicket>;
  /** Default: `io` from socket.io-client. */
  createSocket?: RealtimeSocketFactory;
  /** Exponential backoff (x2, full jitter). Default 1000 ms initial, 30000 ms cap. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number;
  onError?: (error: unknown) => void;
}

const defaultCreateSocket: RealtimeSocketFactory = (url, options) => io(url, options);

type Listener = (payload: never) => void;

export class RealtimeClient {
  private readonly fetchTicket: () => Promise<RealtimeTicket>;
  private readonly createSocket: RealtimeSocketFactory;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;
  private readonly onError: ((error: unknown) => void) | undefined;

  private state: RealtimeStatus = 'idle';
  private socket: RealtimeSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Failed attempts since the last successful connect. */
  private attempt = 0;
  /** Bumped on every (re)connect and on stop: stale async work checks it. */
  private generation = 0;
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private readonly eventListeners = new Map<RealtimeServerEvent, Set<Listener>>();
  private readonly rooms = new Map<string, number>();

  constructor(options: RealtimeClientOptions = {}) {
    this.fetchTicket = options.fetchTicket ?? (() => fetchRealtimeTicket());
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.initialMs = options.backoff?.initialMs ?? 1000;
    this.maxMs = options.backoff?.maxMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.onError = options.onError;
  }

  get status(): RealtimeStatus {
    return this.state;
  }

  /** Connects; a no-op while already running. A stopped client can be started again. */
  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.attempt = 0;
    this.connect('connecting');
  }

  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.dropSocket();
    this.setStatus('stopped');
  }

  onStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  on<E extends RealtimeServerEvent>(
    event: E,
    listener: (payload: RealtimeServerEventPayload<E>) => void,
  ): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    const entry = listener as unknown as Listener;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Joins the course room (ref-counted); re-joined after every reconnect. */
  subscribeCourse(courseId: string): () => void {
    const count = this.rooms.get(courseId) ?? 0;
    this.rooms.set(courseId, count + 1);
    if (count === 0) this.emitRoom('subscribe', courseId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.rooms.get(courseId) ?? 1) - 1;
      if (left > 0) {
        this.rooms.set(courseId, left);
        return;
      }
      this.rooms.delete(courseId);
      this.emitRoom('unsubscribe', courseId);
    };
  }

  /* ------------------------------------------------------------------ internals ---- */

  private connect(status: 'connecting' | 'reconnecting'): void {
    this.clearTimer();
    this.dropSocket();
    const generation = ++this.generation;
    this.setStatus(status);
    this.fetchTicket().then(
      (ticket) => {
        if (generation !== this.generation) return;
        this.open(ticket, generation);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.onError?.(error);
        if (
          error instanceof RealtimeTicketError &&
          (error.status === 401 || error.status === 403)
        ) {
          this.halt();
          return;
        }
        this.scheduleRetry();
      },
    );
  }

  private open(ticket: RealtimeTicket, generation: number): void {
    const socket = this.createSocket(ticket.url, {
      path: REALTIME_SOCKET_PATH,
      transports: [...REALTIME_TRANSPORTS],
      auth: { ticket: ticket.ticket },
      reconnection: false,
      autoConnect: true,
      withCredentials: false,
    });
    this.socket = socket;
    const current = () => generation === this.generation && this.socket === socket;

    socket.on('connect', () => {
      if (!current()) return;
      this.attempt = 0;
      this.setStatus('connected');
      for (const courseId of this.rooms.keys()) this.emitRoom('subscribe', courseId);
    });
    socket.on('disconnect', (reason: string) => {
      if (!current()) return;
      if (reason === 'io client disconnect') return;
      if (reason === 'io server disconnect') {
        this.reconnectNow();
        return;
      }
      this.socket = null;
      this.scheduleRetry();
    });
    socket.on('connect_error', (error: unknown) => {
      if (!current()) return;
      this.onError?.(error);
      const message = error instanceof Error ? error.message : String(error);
      this.dropSocket();
      if (message === 'session_revoked') {
        this.halt();
        return;
      }
      this.scheduleRetry();
    });
    for (const event of REALTIME_SERVER_EVENTS) {
      socket.on(event, (payload: unknown) => {
        if (!current()) return;
        this.dispatch(event, payload);
        if (event === 'session.reauth') this.reconnectNow();
      });
    }
  }

  private dispatch(event: RealtimeServerEvent, raw: unknown): void {
    let payload: unknown;
    try {
      payload = parseRealtimeServerEvent(event, raw);
    } catch (error) {
      this.onError?.(error);
      return; // not a hint we understand: drop it
    }
    for (const listener of [...(this.eventListeners.get(event) ?? [])]) {
      (listener as (value: unknown) => void)(payload);
    }
  }

  private emitRoom(event: 'subscribe' | 'unsubscribe', courseId: string): void {
    const socket = this.socket;
    if (!socket?.connected || this.state !== 'connected') return;
    socket.emit(event, { courseId }, (ack: unknown) => {
      if (ack && typeof ack === 'object' && 'ok' in ack && ack.ok === false) {
        this.onError?.(new Error(`Realtime ${event} ${courseId} refused`));
      }
    });
  }

  private reconnectNow(): void {
    this.attempt = 0;
    this.connect('reconnecting');
  }

  private scheduleRetry(): void {
    this.clearTimer();
    const ceiling = Math.min(this.maxMs, this.initialMs * 2 ** this.attempt);
    const delay = Math.floor(this.random() * ceiling);
    this.attempt += 1;
    this.setStatus('reconnecting');
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      this.connect('reconnecting');
    }, delay);
  }

  private halt(): void {
    this.generation += 1;
    this.clearTimer();
    this.dropSocket();
    this.setStatus('stopped');
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.disconnect();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.state === status) return;
    this.state = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
