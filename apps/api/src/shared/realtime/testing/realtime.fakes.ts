import { randomBytes } from 'node:crypto';
import { REALTIME_LIMITS } from '@udemy/contracts';
import { RealtimeConnectionLimiter } from '../realtime-connection.limiter';
import type { RealtimeSessionRevocations } from '../realtime-session-revocations';
import { type IssuedWsTicket, type WsTicketGrant, WsTicketStore } from '../ws-ticket.store';

/** In-memory `WsTicketStore` (single use, no TTL): for tests without Redis. */
export class InMemoryWsTicketStore extends WsTicketStore {
  readonly grants = new Map<string, WsTicketGrant>();
  failing: Error | undefined;

  issue(grant: WsTicketGrant): Promise<IssuedWsTicket> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    const ticket = randomBytes(32).toString('base64url');
    this.grants.set(ticket, grant);
    return Promise.resolve({
      ticket,
      expiresAt: new Date(Date.now() + REALTIME_LIMITS.ticketTtlSeconds * 1000),
    });
  }

  consume(ticket: string): Promise<WsTicketGrant | null> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    const grant = this.grants.get(ticket) ?? null;
    this.grants.delete(ticket);
    return Promise.resolve(grant);
  }
}

/** In-memory session revocations. */
export class FakeSessionRevocations implements RealtimeSessionRevocations {
  readonly revoked = new Set<string>();
  failing: Error | undefined;

  isRevoked(sessionId: string): Promise<boolean> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    return Promise.resolve(this.revoked.has(sessionId));
  }

  revokedAmong(sessionIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    return Promise.resolve(new Set(sessionIds.filter((id) => this.revoked.has(id))));
  }
}

/** In-memory per-user connection counter with the production cap. */
export class InMemoryConnectionLimiter extends RealtimeConnectionLimiter {
  readonly counts = new Map<string, number>();
  failing: Error | undefined;

  acquire(userId: string): Promise<boolean> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    const count = this.counts.get(userId) ?? 0;
    if (count >= REALTIME_LIMITS.maxSocketsPerUser) return Promise.resolve(false);
    this.counts.set(userId, count + 1);
    return Promise.resolve(true);
  }

  release(userId: string): Promise<void> {
    const count = (this.counts.get(userId) ?? 0) - 1;
    if (count > 0) this.counts.set(userId, count);
    else this.counts.delete(userId);
    return Promise.resolve();
  }
}

/** A grant as `POST /realtime/tickets` stores it for a student-app principal. */
export function studentGrant(overrides: Partial<WsTicketGrant> = {}): WsTicketGrant {
  return {
    userId: '01900000-0000-7000-8000-00000000a001',
    sessionId: '01900000-0000-7000-8000-00000000b001',
    app: 'student',
    roles: ['STUDENT'],
    permissions: ['notification:manage:own'],
    tokenId: '01900000-0000-7000-8000-00000000c001',
    ...overrides,
  };
}
