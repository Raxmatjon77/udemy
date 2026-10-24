// Must be the first import: sets process.env before app.module validates it.
import './testing/apply-test-env';
import { type CanActivate, Module } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/internal';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketServer,
} from '@nestjs/websockets';
import { REALTIME_SOCKET_PATH } from '@udemy/contracts';
import { DATABASE } from '@udemy/nest-common';
import type { Server, Socket } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module';
import { PoliciesGuard } from './modules/access';
import { ClientAuthGuard, JwtAuthGuard } from './modules/identity';
import { API_APP_OPTIONS, setupApp } from './setup-app';
import { AuthenticatedOnly, RequirePermissions } from './shared/auth';
import {
  getRealtimeIdentity,
  InMemoryRealtimeAdapterFactory,
  REALTIME_SESSION_REVOCATIONS,
  RealtimeAdapterFactory,
  RealtimeConnectionLimiter,
  RealtimeGateway,
  WsTicketStore,
} from './shared/realtime';
import { REDIS } from './shared/redis';
import { RealtimeAwareThrottlerGuard } from './shared/throttler';
import {
  FakeSessionRevocations,
  InMemoryConnectionLimiter,
  InMemoryWsTicketStore,
  studentGrant,
} from './shared/realtime/testing/realtime.fakes';

/*
 * Design §12 risk "T5: Nest 12 global APP_GUARDs execute on socket.io handlers, and the guards'
 * ws branch works". The REAL AppModule (all four APP_GUARDs, the RouteSecurityAuditor, setupApp
 * with installRealtimeAdapter) plus a probe @RealtimeGateway, served on 127.0.0.1 and driven by a
 * real socket.io client. No Postgres/Redis: the clients are fakes, the ticket store, revocations
 * and connection cap are in memory, and socket.io uses its in-memory adapter.
 */

const ALLOWED_ORIGIN = 'http://localhost:3000';

const whoami = vi.fn();
const adminOnly = vi.fn();

@RealtimeGateway()
class ProbeGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage('probe.whoami')
  @AuthenticatedOnly()
  whoami(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): unknown {
    whoami(body);
    const identity = getRealtimeIdentity(socket);
    return { userId: identity?.principal.userId, app: identity?.principal.app };
  }

  @SubscribeMessage('probe.admin')
  @RequirePermissions('user:read:any')
  admin(): unknown {
    adminOnly();
    return { ok: true };
  }
}

@Module({ providers: [ProbeGateway] })
class ProbeModule {}

/** Not a gateway: only used to build execution contexts. */
class PlainClass {
  handler(): void {}
}

const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
const tickets = new InMemoryWsTicketStore();
const sessions = new FakeSessionRevocations();
const limiter = new InMemoryConnectionLimiter();

type Connected = { ok: true; socket: ClientSocket } | { ok: false; error: string };

describe('realtime gateway under the global guards (real AppModule, socket.io client)', () => {
  let app: NestExpressApplication;
  let url: string;
  let guards: Record<'client' | 'throttle' | 'jwt' | 'policies', CanActivate>;
  const opened: ClientSocket[] = [];

  function connect(options: { origin?: string; ticket?: string }): Promise<Connected> {
    return new Promise((resolve) => {
      const socket = io(url, {
        path: REALTIME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: options.ticket === undefined ? {} : { ticket: options.ticket },
        extraHeaders: options.origin === undefined ? {} : { origin: options.origin },
      });
      opened.push(socket);
      socket.once('connect', () => resolve({ ok: true, socket }));
      socket.once('connect_error', (error: Error) => resolve({ ok: false, error: error.message }));
    });
  }

  async function connectAsStudent(): Promise<ClientSocket> {
    const { ticket } = await tickets.issue(studentGrant());
    const result = await connect({ origin: ALLOWED_ORIGIN, ticket });
    if (!result.ok) throw new Error(`connect failed: ${result.error}`);
    return result.socket;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(WsTicketStore)
      .useValue(tickets)
      .overrideProvider(REALTIME_SESSION_REVOCATIONS)
      .useValue(sessions)
      .overrideProvider(RealtimeConnectionLimiter)
      .useValue(limiter)
      .overrideProvider(RealtimeAdapterFactory)
      .useValue(new InMemoryRealtimeAdapterFactory())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
    guards = {
      client: app.get(ClientAuthGuard, { strict: false }),
      throttle: app.get(RealtimeAwareThrottlerGuard, { strict: false }),
      jwt: app.get(JwtAuthGuard, { strict: false }),
      policies: app.get(PoliciesGuard, { strict: false }),
    };
  });

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
    vi.restoreAllMocks();
    whoami.mockClear();
    adminOnly.mockClear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs all four global guards, in order, on a gateway handler', async () => {
    const calls: string[] = [];
    for (const [name, guard] of Object.entries(guards)) {
      const original = guard.canActivate.bind(guard);
      vi.spyOn(guard, 'canActivate').mockImplementation((ctx) => {
        calls.push(`${name}:${ctx.getType()}:${ctx.getClass().name}.${ctx.getHandler().name}`);
        return original(ctx);
      });
    }
    const socket = await connectAsStudent();

    const reply: unknown = await socket.emitWithAck('probe.whoami', { hello: 1 });

    expect(reply).toEqual({ userId: studentGrant().userId, app: 'student' });
    expect(whoami).toHaveBeenCalledWith({ hello: 1 });
    expect(calls).toEqual([
      'client:ws:ProbeGateway.whoami',
      'throttle:ws:ProbeGateway.whoami',
      'jwt:ws:ProbeGateway.whoami',
      'policies:ws:ProbeGateway.whoami',
    ]);
  });

  it('PoliciesGuard enforces @RequirePermissions with the socket principal', async () => {
    const socket = await connectAsStudent();
    const exception = new Promise<unknown>((resolve) => socket.once('exception', resolve));

    socket.emit('probe.admin', {});

    await expect(exception).resolves.toMatchObject({
      status: 'error',
      message: 'Forbidden resource',
    });
    expect(adminOnly).not.toHaveBeenCalled();
  });

  it('a socket with the permission passes', async () => {
    const { ticket } = await tickets.issue(
      studentGrant({ app: 'admin', roles: ['STUDENT', 'ADMIN'], permissions: ['user:read:any'] }),
    );
    const result = await connect({ origin: ALLOWED_ORIGIN, ticket });
    if (!result.ok) throw new Error(result.error);

    await expect(result.socket.emitWithAck('probe.admin', {})).resolves.toEqual({ ok: true });
    expect(adminOnly).toHaveBeenCalledTimes(1);
  });

  it('joins only the server-assigned user room on connect', async () => {
    const socket = await connectAsStudent();
    const probe = app.get(ProbeGateway, { strict: false });
    const rooms = probe.server.of('/').adapter.rooms;
    const userRoom = `u:${studentGrant().userId}:STUDENT`;
    expect(rooms.get(userRoom)?.has(socket.id ?? '')).toBe(true);
  });

  it.each([
    ['a foreign origin', 'https://evil.example.test', 'origin_not_allowed'],
    ['no origin', undefined, 'origin_not_allowed'],
  ])('refuses %s', async (_, origin, code) => {
    const { ticket } = await tickets.issue(studentGrant());
    await expect(connect({ origin, ticket })).resolves.toEqual({ ok: false, error: code });
  });

  it('refuses a missing, unknown or replayed ticket', async () => {
    await expect(connect({ origin: ALLOWED_ORIGIN })).resolves.toEqual({
      ok: false,
      error: 'ticket_invalid',
    });
    await expect(connect({ origin: ALLOWED_ORIGIN, ticket: 'B'.repeat(43) })).resolves.toEqual({
      ok: false,
      error: 'ticket_invalid',
    });
    const { ticket } = await tickets.issue(studentGrant());
    expect((await connect({ origin: ALLOWED_ORIGIN, ticket })).ok).toBe(true);
    await expect(connect({ origin: ALLOWED_ORIGIN, ticket })).resolves.toEqual({
      ok: false,
      error: 'ticket_invalid',
    });
  });

  it('refuses a revoked session and the connection over the cap', async () => {
    const revoked = studentGrant({ sessionId: '01900000-0000-7000-8000-00000000b0ff' });
    sessions.revoked.add(revoked.sessionId);
    const first = await tickets.issue(revoked);
    await expect(connect({ origin: ALLOWED_ORIGIN, ticket: first.ticket })).resolves.toEqual({
      ok: false,
      error: 'session_revoked',
    });

    const capped = studentGrant({ userId: '01900000-0000-7000-8000-00000000a0ff' });
    limiter.counts.set(capped.userId, 10);
    const second = await tickets.issue(capped);
    await expect(connect({ origin: ALLOWED_ORIGIN, ticket: second.ticket })).resolves.toEqual({
      ok: false,
      error: 'too_many_connections',
    });
  });

  it('releases the connection slot on disconnect', async () => {
    const userId = studentGrant().userId;
    const socket = await connectAsStudent();
    expect(limiter.counts.get(userId)).toBeGreaterThan(0);
    const before = limiter.counts.get(userId) ?? 0;
    const probe = app.get(ProbeGateway, { strict: false });
    const released = new Promise<void>((resolve) => {
      probe.server
        .of('/')
        .sockets.get(socket.id ?? '')
        ?.once('disconnect', () => {
          setImmediate(resolve);
        });
    });
    socket.close();
    await released;
    expect(limiter.counts.get(userId) ?? 0).toBe(before - 1);
  });

  it('serves WebSocket only: long-polling is refused', async () => {
    const res = await request(app.getHttpServer()).get(
      `${REALTIME_SOCKET_PATH}/?EIO=4&transport=polling`,
    );
    expect(res.status).toBe(400);
  });

  it('every global guard denies ws outside @RealtimeGateway, unauthenticated sockets and rpc', async () => {
    const handler = PlainClass.prototype.handler;
    const wsPlain = new ExecutionContextHost([{}], PlainClass, handler);
    wsPlain.setType('ws');
    const wsNoIdentity = new ExecutionContextHost(
      [{}],
      ProbeGateway,
      ProbeGateway.prototype.whoami,
    );
    wsNoIdentity.setType('ws');
    const rpc = new ExecutionContextHost([{}], ProbeGateway, ProbeGateway.prototype.whoami);
    rpc.setType('rpc');

    for (const [name, guard] of Object.entries(guards)) {
      for (const ctx of [wsPlain, wsNoIdentity, rpc]) {
        await expect(
          Promise.resolve(guard.canActivate(ctx)),
          `${name}/${ctx.getType()}`,
        ).resolves.toBe(false);
      }
    }
  });
});
