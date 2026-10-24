import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ErrorCode, NOTIFICATION_RATE_LIMITS, type RealtimeTicket } from '@udemy/contracts';
import type { Principal } from '../auth';
import { AppConfigService } from '../config';
import { RateLimitedError } from '../errors/rate-limited.error';
import { RateLimiter, RedisUnavailableError } from '../redis';
import { WsTicketStore } from './ws-ticket.store';

/** `rl:ntf:ws-ticket:u:{userId}` (design §6 "Redis keys", §9: 30 per 10 min per user). */
export function wsTicketRateLimitKey(userId: string): string {
  return `rl:ntf:ws-ticket:u:${userId}`;
}

/**
 * `POST /realtime/tickets` (design D16): a single-use, 30 s ticket for the socket.io handshake,
 * bound to the calling principal (user, session, app, roles, permissions).
 *
 * - 429 `rate_limited` beyond 30 tickets per 10 minutes per user.
 * - 503 `realtime_unavailable` when Redis (rate limit or ticket store) is down: fail closed.
 */
@Injectable()
export class IssueRealtimeTicket {
  constructor(
    private readonly config: AppConfigService,
    private readonly limiter: RateLimiter,
    private readonly tickets: WsTicketStore,
  ) {}

  async execute(principal: Principal): Promise<RealtimeTicket> {
    try {
      const rule = NOTIFICATION_RATE_LIMITS.realtimeTicket;
      const limit = await this.limiter.hit(wsTicketRateLimitKey(principal.userId), {
        limit: rule.limit,
        windowMs: rule.windowSeconds * 1000,
      });
      if (limit.limited) {
        throw new RateLimitedError('Too many realtime connections. Please retry later.', {
          retryAfterMs: limit.ttlMs,
        });
      }
      const issued = await this.tickets.issue({
        userId: principal.userId,
        sessionId: principal.sessionId,
        app: principal.app,
        roles: principal.roles,
        permissions: [...principal.permissions],
        tokenId: principal.tokenId,
      });
      return {
        ticket: issued.ticket,
        url: this.config.get('REALTIME_PUBLIC_URL'),
        expiresAt: issued.expiresAt.toISOString(),
      };
    } catch (error) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      throw new ServiceUnavailableException(
        {
          message: 'Realtime updates are temporarily unavailable. Please retry later.',
          code: ErrorCode.RealtimeUnavailable,
        },
        { cause: error },
      );
    }
  }
}
