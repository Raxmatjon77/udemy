import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ErrorCode, RealtimeTicketSchema } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth';
import type { AppConfigService } from '../config';
import { RateLimitedError } from '../errors/rate-limited.error';
import { type RateLimiter, RedisUnavailableError } from '../redis';
import { IssueRealtimeTicket, wsTicketRateLimitKey } from './issue-realtime-ticket';
import { InMemoryWsTicketStore } from './testing/realtime.fakes';

const principal: Principal = {
  userId: '01900000-0000-7000-8000-00000000a001',
  sessionId: '01900000-0000-7000-8000-00000000b001',
  app: 'instructor',
  roles: ['STUDENT', 'INSTRUCTOR'],
  permissions: new Set(['notification:manage:own', 'course:create']),
  tokenId: 'jti-1',
};

function setup(hit: RateLimiter['hit']) {
  const config = {
    get: (key: string) => (key === 'REALTIME_PUBLIC_URL' ? 'http://localhost:4000' : undefined),
  } as unknown as AppConfigService;
  const limiter = { hit: vi.fn(hit) };
  const tickets = new InMemoryWsTicketStore();
  const useCase = new IssueRealtimeTicket(config, limiter as unknown as RateLimiter, tickets);
  return { useCase, limiter, tickets };
}

const allow: RateLimiter['hit'] = async () => ({ count: 1, ttlMs: 600_000, limited: false });

describe('IssueRealtimeTicket', () => {
  it('returns a contract-valid ticket bound to the whole principal', async () => {
    const { useCase, limiter, tickets } = setup(allow);
    const result = await useCase.execute(principal);

    expect(RealtimeTicketSchema.parse(result)).toEqual(result);
    expect(result.url).toBe('http://localhost:4000');
    expect(limiter.hit).toHaveBeenCalledWith(wsTicketRateLimitKey(principal.userId), {
      limit: 30,
      windowMs: 600_000,
    });
    await expect(tickets.consume(result.ticket)).resolves.toEqual({
      userId: principal.userId,
      sessionId: principal.sessionId,
      app: 'instructor',
      roles: ['STUDENT', 'INSTRUCTOR'],
      permissions: ['notification:manage:own', 'course:create'],
      tokenId: 'jti-1',
    });
  });

  it('429 beyond the per-user limit, without issuing', async () => {
    const { useCase, tickets } = setup(async () => ({ count: 31, ttlMs: 4_500, limited: true }));
    const error = await useCase.execute(principal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(5);
    expect(tickets.grants.size).toBe(0);
  });

  it('503 realtime_unavailable when Redis is down (limiter or store)', async () => {
    const down = setup(async () => Promise.reject(new RedisUnavailableError()));
    const storeDown = setup(allow);
    storeDown.tickets.failing = new RedisUnavailableError();

    for (const { useCase } of [down, storeDown]) {
      const error = await useCase.execute(principal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const http = error as ServiceUnavailableException;
      expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(http.getResponse()).toMatchObject({ code: ErrorCode.RealtimeUnavailable });
    }
  });
});
