import { Logger } from '@nestjs/common';
import { REALTIME_LIMITS } from '@udemy/contracts';
import type { Socket } from 'socket.io';
import { getRealtimeIdentity } from './realtime-identity';
import type { RealtimeSessionRevocations } from './realtime-session-revocations';

/**
 * The 60 s revoked-session sweep of the sockets connected to THIS replica (design D16): a
 * logout, a logout-all, a ban or a password change revokes the session (`auth:revoked:sid:*`,
 * P1 D11); the handshake already refuses such a session, and this sweep closes the sockets that
 * were opened before the revocation, within one interval.
 *
 * One `revokedAmong` call (batched MGETs) per sweep over the distinct sessions of the tracked
 * sockets; every socket of a revoked session is disconnected (the client's next ticket request
 * then gets 401 and it stops). Sweeps never overlap. A failed lookup (Redis down) keeps the
 * sockets and is retried on the next tick: the 15 min connection cap still bounds their life,
 * and disconnecting every socket during an outage would only start a reconnect storm that the
 * handshake (fail closed) refuses anyway.
 */
export class RealtimeRevocationSweep {
  private readonly logger = new Logger(RealtimeRevocationSweep.name);
  private readonly sockets = new Set<Socket>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly sessions: RealtimeSessionRevocations,
    private readonly intervalMs: number = REALTIME_LIMITS.revocationSweepSeconds * 1000,
  ) {}

  /** Number of sockets currently tracked (tests, diagnostics). */
  get size(): number {
    return this.sockets.size;
  }

  /** Starts the periodic sweep. Idempotent; the timer never keeps the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.sockets.clear();
  }

  /** Tracks an authenticated socket until `untrack` (its disconnect). */
  track(socket: Socket): void {
    this.sockets.add(socket);
  }

  untrack(socket: Socket): void {
    this.sockets.delete(socket);
  }

  /**
   * One sweep: disconnects the tracked sockets whose session is revoked and returns how many it
   * closed (0 when a sweep is already running or the lookup failed). Never throws.
   */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const bySession = new Map<string, Socket[]>();
      for (const socket of this.sockets) {
        const sessionId = getRealtimeIdentity(socket)?.principal.sessionId;
        if (sessionId === undefined) continue;
        const group = bySession.get(sessionId);
        if (group === undefined) bySession.set(sessionId, [socket]);
        else group.push(socket);
      }
      if (bySession.size === 0) return 0;

      let revoked: ReadonlySet<string>;
      try {
        revoked = await this.sessions.revokedAmong([...bySession.keys()]);
      } catch (error) {
        this.logger.warn(
          { err: error, sessions: bySession.size },
          'WS revocation sweep could not read revoked sessions; retrying next interval',
        );
        return 0;
      }

      let closed = 0;
      for (const sessionId of revoked) {
        for (const socket of bySession.get(sessionId) ?? []) {
          this.sockets.delete(socket);
          if (!socket.connected) continue;
          socket.disconnect(true);
          closed += 1;
        }
      }
      if (closed > 0) {
        this.logger.log(
          { closed, sessions: revoked.size },
          'Closed WS connections of revoked sessions',
        );
      }
      return closed;
    } finally {
      this.running = false;
    }
  }
}
