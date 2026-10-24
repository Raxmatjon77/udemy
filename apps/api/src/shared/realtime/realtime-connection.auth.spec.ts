import { REALTIME_LIMITS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config';
import {
  normalizeOrigin,
  RealtimeConnectError,
  RealtimeConnectionAuth,
} from './realtime-connection.auth';
import {
  FakeSessionRevocations,
  InMemoryConnectionLimiter,
  InMemoryWsTicketStore,
  studentGrant,
} from './testing/realtime.fakes';

const ALLOWED = 'http://localhost:3000';

function setup() {
  const config = {
    get: (key: string) =>
      key === 'REALTIME_ALLOWED_ORIGINS'
        ? [`${ALLOWED}/`, 'https://teach.example.test']
        : undefined,
  } as unknown as AppConfigService;
  const tickets = new InMemoryWsTicketStore();
  const sessions = new FakeSessionRevocations();
  const limiter = new InMemoryConnectionLimiter();
  const auth = new RealtimeConnectionAuth(config, tickets, sessions, limiter);
  return { auth, tickets, sessions, limiter };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RealtimeConnectError);
  return (error as RealtimeConnectError).code;
}

describe('RealtimeConnectionAuth', () => {
  it('admits a fresh ticket from an allowed origin and rebuilds the principal', async () => {
    const { auth, tickets, limiter } = setup();
    const grant = studentGrant();
    const { ticket } = await tickets.issue(grant);
    const now = new Date('2026-10-24T10:00:00.000Z');

    const identity = await auth.authenticate({ origin: ALLOWED, auth: { ticket } }, now);

    expect(identity.principal).toEqual({
      userId: grant.userId,
      sessionId: grant.sessionId,
      app: 'student',
      roles: ['STUDENT'],
      permissions: new Set(['notification:manage:own']),
      tokenId: grant.tokenId,
    });
    expect(identity.origin).toBe(ALLOWED);
    expect(identity.connectedAt).toBe(now);
    expect(identity.expiresAt.getTime() - now.getTime()).toBe(
      REALTIME_LIMITS.maxConnectionSeconds * 1000,
    );
    expect(limiter.counts.get(grant.userId)).toBe(1);
  });

  it.each([
    ['a foreign origin', 'https://evil.example.test'],
    ['no origin', undefined],
    ['the opaque origin', 'null'],
    ['garbage', 'not a url'],
  ])('refuses %s with origin_not_allowed before touching the ticket', async (_, origin) => {
    const { auth, tickets } = setup();
    const { ticket } = await tickets.issue(studentGrant());
    expect(await refusal(auth.authenticate({ origin, auth: { ticket } }))).toBe(
      'origin_not_allowed',
    );
    expect(tickets.grants.size).toBe(1);
  });

  it.each([
    ['no auth payload', undefined],
    ['a non-object', 'ticket'],
    ['a malformed ticket', { ticket: 'short' }],
    ['an unknown ticket', { ticket: 'A'.repeat(43) }],
  ])('refuses %s with ticket_invalid', async (_, payload) => {
    const { auth } = setup();
    expect(await refusal(auth.authenticate({ origin: ALLOWED, auth: payload }))).toBe(
      'ticket_invalid',
    );
  });

  it('a ticket works once', async () => {
    const { auth, tickets } = setup();
    const { ticket } = await tickets.issue(studentGrant());
    await auth.authenticate({ origin: ALLOWED, auth: { ticket } });
    expect(await refusal(auth.authenticate({ origin: ALLOWED, auth: { ticket } }))).toBe(
      'ticket_invalid',
    );
  });

  it('refuses a revoked session (and the ticket is spent)', async () => {
    const { auth, tickets, sessions, limiter } = setup();
    const grant = studentGrant();
    sessions.revoked.add(grant.sessionId);
    const { ticket } = await tickets.issue(grant);
    expect(await refusal(auth.authenticate({ origin: ALLOWED, auth: { ticket } }))).toBe(
      'session_revoked',
    );
    expect(tickets.grants.size).toBe(0);
    expect(limiter.counts.size).toBe(0);
  });

  it('refuses the socket over the per-user cap', async () => {
    const { auth, tickets, limiter } = setup();
    const grant = studentGrant();
    limiter.counts.set(grant.userId, REALTIME_LIMITS.maxSocketsPerUser);
    const { ticket } = await tickets.issue(grant);
    expect(await refusal(auth.authenticate({ origin: ALLOWED, auth: { ticket } }))).toBe(
      'too_many_connections',
    );
  });

  it('fails closed as ticket_invalid when a store is down', async () => {
    for (const broken of ['tickets', 'sessions', 'limiter'] as const) {
      const ctx = setup();
      const { ticket } = await ctx.tickets.issue(studentGrant());
      ctx[broken].failing = new Error('redis down');
      expect(await refusal(ctx.auth.authenticate({ origin: ALLOWED, auth: { ticket } }))).toBe(
        'ticket_invalid',
      );
    }
  });

  it('release frees the slot and never throws', async () => {
    const { auth, tickets, limiter } = setup();
    const { ticket } = await tickets.issue(studentGrant());
    const identity = await auth.authenticate({ origin: ALLOWED, auth: { ticket } });
    await auth.release(identity);
    expect(limiter.counts.size).toBe(0);

    limiter.release = () => Promise.reject(new Error('redis down'));
    await expect(auth.release(identity)).resolves.toBeUndefined();
  });

  it('normalizes origins', () => {
    expect(normalizeOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeOrigin('HTTPS://Example.TEST:443')).toBe('https://example.test');
    expect(normalizeOrigin('null')).toBeUndefined();
    expect(normalizeOrigin(undefined)).toBeUndefined();
  });
});
