import type { Socket } from 'socket.io';
import type { Principal } from '../auth';

/**
 * Who is behind a socket.io connection: established once, by the handshake middleware of
 * `RedisIoAdapter` (`RealtimeConnectionAuth`), from a single-use ticket that an authenticated
 * HTTP request issued (design D16). Immutable for the life of the socket.
 */
export interface RealtimeIdentity {
  /**
   * The principal of the request that issued the ticket (user, session, app, roles and the
   * effective permissions at that moment). Like an access token, it is at most
   * `REALTIME_LIMITS.maxConnectionSeconds` old: the socket is closed at `expiresAt`.
   */
  readonly principal: Principal;
  /** The handshake's `Origin` (one of `REALTIME_ALLOWED_ORIGINS`). */
  readonly origin: string;
  readonly connectedAt: Date;
  /** The server sends `session.reauth` and disconnects at this instant (15 min cap). */
  readonly expiresAt: Date;
}

/**
 * Stored outside the socket (not in `socket.data`, which the Redis adapter serializes for remote
 * `fetchSockets`), so nothing parsed from the wire can ever set or replace it.
 */
const identities = new WeakMap<Socket, RealtimeIdentity>();

/** Called by the handshake middleware only. A socket's identity can be set once. */
export function setRealtimeIdentity(socket: Socket, identity: RealtimeIdentity): void {
  if (identities.has(socket)) throw new Error('Realtime identity is already set for this socket');
  identities.set(socket, identity);
}

/** The socket's identity; undefined for a socket that did not pass the handshake checks. */
export function getRealtimeIdentity(socket: Socket): RealtimeIdentity | undefined {
  return identities.get(socket);
}

/** `getRealtimeIdentity` for a value that may not be a socket (an execution context's client). */
export function realtimeIdentityOf(client: unknown): RealtimeIdentity | undefined {
  if (typeof client !== 'object' || client === null) return undefined;
  return identities.get(client as Socket);
}
