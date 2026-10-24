// Must stay the first import: AppModule (imported by the harness) validates process.env.
import './testing/e2e/apply-e2e-app-env';
import { Module } from '@nestjs/common';
import { ConnectedSocket, SubscribeMessage } from '@nestjs/websockets';
import {
  ErrorCode,
  REALTIME_LIMITS,
  REALTIME_SOCKET_PATH,
  RealtimeTicketSchema,
  realtimeUserRoom,
} from '@udemy/contracts';
import type { Socket } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SessionRevocationStore } from './modules/identity';
import { AuthenticatedOnly } from './shared/auth';
import {
  getRealtimeIdentity,
  RealtimeEmitter,
  RealtimeGateway,
  wsConnectionKey,
  wsTicketRateLimitKey,
} from './shared/realtime';
import { expectProblem, useE2eApp } from './testing/e2e/e2e-harness';
import { TEST_ENV } from './testing/test-env';

/*
 * P5-T5 realtime plumbing end to end: the real AppModule with real Postgres + Redis, the Redis
 * socket.io adapter installed by setupApp, and a real socket.io client. Until P5-T14 adds
 * NotificationsGateway, a probe @RealtimeGateway stands in for it.
 *
 * Covers: POST /realtime/tickets (auth, contract, no-store, 429), the handshake refusals
 * (bad origin, replayed ticket, revoked session), the server-assigned user room reached through
 * Redis, and the global guards on a gateway handler.
 */

const ORIGIN = TEST_ENV.REALTIME_ALLOWED_ORIGINS.split(',')[0] ?? '';

@RealtimeGateway()
class E2eProbeGateway {
  @SubscribeMessage('probe.whoami')
  @AuthenticatedOnly()
  whoami(@ConnectedSocket() socket: Socket): unknown {
    const identity = getRealtimeIdentity(socket);
    return { userId: identity?.principal.userId, app: identity?.principal.app };
  }
}

@Module({ providers: [E2eProbeGateway] })
class E2eProbeModule {}

type Connected = { ok: true; socket: ClientSocket } | { ok: false; error: string };

describe('realtime (e2e)', () => {
  const e2e = useE2eApp({ imports: [E2eProbeModule] });
  const sockets: ClientSocket[] = [];
  const touchedUsers = new Set<string>();

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    if (!e2e.redis.available || touchedUsers.size === 0) return;
    const keys = [...touchedUsers].flatMap((id) => [wsConnectionKey(id), wsTicketRateLimitKey(id)]);
    await e2e.redis.redis.del(...keys);
  });

  async function student(): Promise<{ userId: string; accessToken: string; sessionId: string }> {
    const user = await e2e.signup();
    await e2e.verifyEmailViaSql(user.userId);
    const auth = await e2e.login('student', user.email);
    touchedUsers.add(user.userId);
    const row = await e2e.pg.db
      .selectFrom('identity.sessions')
      .select('id')
      .where('userId', '=', user.userId)
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    return { userId: user.userId, accessToken: auth.accessToken, sessionId: row.id };
  }

  async function ticketFor(accessToken: string): Promise<string> {
    const res = await e2e.as('student', accessToken).post('/api/v1/realtime/tickets');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return RealtimeTicketSchema.parse(res.body).ticket;
  }

  async function connect(options: { ticket?: string; origin?: string }): Promise<Connected> {
    const url = await e2e.realtimeUrl();
    return new Promise((resolve) => {
      const socket = io(url, {
        path: REALTIME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: options.ticket === undefined ? {} : { ticket: options.ticket },
        extraHeaders: { origin: options.origin ?? ORIGIN },
      });
      sockets.push(socket);
      socket.once('connect', () => resolve({ ok: true, socket }));
      socket.once('connect_error', (error: Error) => resolve({ ok: false, error: error.message }));
    });
  }

  it('POST /realtime/tickets issues a contract ticket (Bearer + BFF), never cached', async (ctx) => {
    e2e.skip(ctx);
    const { accessToken } = await student();

    const res = await e2e.as('student', accessToken).post('/api/v1/realtime/tickets');

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = RealtimeTicketSchema.parse(res.body);
    expect(body.url).toBe(TEST_ENV.REALTIME_PUBLIC_URL);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
      REALTIME_LIMITS.ticketTtlSeconds * 1000,
    );
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POST /realtime/tickets needs a user and a BFF', async (ctx) => {
    e2e.skip(ctx);
    expectProblem(
      await e2e.http().post('/api/v1/realtime/tickets').set(e2e.client('student')),
      401,
      ErrorCode.Unauthorized,
    );
    const { accessToken } = await student();
    expectProblem(
      await e2e
        .http()
        .post('/api/v1/realtime/tickets')
        .set('authorization', `Bearer ${accessToken}`),
      401,
      ErrorCode.Unauthorized,
    );
  });

  it('a ticket opens one socket that runs gateway handlers as its user, in the user room', async (ctx) => {
    e2e.skip(ctx);
    const { userId, accessToken } = await student();
    const ticket = await ticketFor(accessToken);

    const first = await connect({ ticket });
    if (!first.ok) throw new Error(first.error);
    await expect(first.socket.emitWithAck('probe.whoami', {})).resolves.toEqual({
      userId,
      app: 'student',
    });

    // Through Redis (the adapter every replica and the worker's emitter share).
    const hint = new Promise<unknown>((resolve) =>
      first.socket.once('notification.unread', resolve),
    );
    await e2e.app
      .get(RealtimeEmitter, { strict: false })
      .emit(realtimeUserRoom(userId, 'STUDENT'), 'notification.unread', { count: 2 });
    await expect(hint).resolves.toEqual({ count: 2 });

    await expect(connect({ ticket })).resolves.toEqual({ ok: false, error: 'ticket_invalid' });
  });

  it('refuses a foreign origin and a revoked session', async (ctx) => {
    e2e.skip(ctx);
    const { accessToken, sessionId } = await student();

    await expect(
      connect({ ticket: await ticketFor(accessToken), origin: 'https://evil.example.test' }),
    ).resolves.toEqual({ ok: false, error: 'origin_not_allowed' });

    const ticket = await ticketFor(accessToken);
    await e2e.app.get(SessionRevocationStore, { strict: false }).revoke(sessionId);
    await expect(connect({ ticket })).resolves.toEqual({ ok: false, error: 'session_revoked' });
  });

  it('caps tickets per user (429 rate_limited)', async (ctx) => {
    e2e.skip(ctx);
    const { userId, accessToken } = await student();
    await e2e.redis.redis.set(wsTicketRateLimitKey(userId), '30', 'EX', 600);

    const res = await e2e.as('student', accessToken).post('/api/v1/realtime/tickets');

    expectProblem(res, 429, ErrorCode.RateLimited);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
