// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { WebSocketServer } from '@nestjs/websockets';
import {
  type CourseRoomAck,
  REALTIME_LIMITS,
  REALTIME_SOCKET_PATH,
  realtimeCourseRoom,
} from '@udemy/contracts';
import { DATABASE } from '@udemy/nest-common';
import type { Server } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import {
  InMemoryRealtimeAdapterFactory,
  REALTIME_SESSION_REVOCATIONS,
  RealtimeAdapterFactory,
  RealtimeConnectionLimiter,
  RealtimeGateway,
  realtimeAdapterOf,
  type WsTicketGrant,
  WsTicketStore,
} from '../../shared/realtime';
import {
  FakeSessionRevocations,
  InMemoryConnectionLimiter,
  InMemoryWsTicketStore,
  studentGrant,
} from '../../shared/realtime/testing/realtime.fakes';
import { REDIS } from '../../shared/redis';
import { CatalogFacade, type PublishedCourseSummary } from '../catalog';
import { EnrollmentFacade } from '../enrollment';
import { NotificationsGateway } from './presentation/notifications.gateway';

/*
 * NotificationsGateway on the real AppModule (global guards, RouteSecurityAuditor, setupApp with
 * the RedisIoAdapter), served on 127.0.0.1 and driven by a real socket.io client. No Postgres or
 * Redis: the catalog and enrollment facades, the ticket store, the session revocations and the
 * connection cap are in-memory fakes, and socket.io uses its in-memory adapter.
 *
 * Covers the course-room subscribe authorization (learner, owner, instructor app, admin,
 * stranger, unknown course, failing check), the 5-rooms cap (also under parallel subscribes),
 * unsubscribe, invalid bodies, and the 60 s revoked-session sweep closing a live socket.
 */

const ORIGIN = 'http://localhost:3000';
const STUDENT = studentGrant().userId;
const OWNER = '01900000-0000-7000-8000-0000000000e1';
const ADMIN = '01900000-0000-7000-8000-0000000000ad';
const course = (n: number): string =>
  `01900000-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const COURSE = course(1);
const UNKNOWN = course(9999);

/** Courses 1–20 exist (owned by OWNER); STUDENT is enrolled in 1–8 except 7; the owner in 7. */
const enrolled = new Set<string>(
  [1, 2, 3, 4, 5, 6, 8].map((n) => `${STUDENT}:${course(n)}`).concat(`${OWNER}:${course(7)}`),
);
let catalogDown = false;
const catalog = {
  getPublishedCourse: vi.fn(async (courseId: string): Promise<PublishedCourseSummary | null> => {
    if (catalogDown) throw new Error('database down');
    const n = Number.parseInt(courseId.slice(-4), 10);
    if (!courseId.startsWith('01900000-0000-7000-8000-0000000c') || n < 1 || n > 20) return null;
    return {
      id: courseId,
      slug: `course-${n}`,
      ownerId: OWNER,
      status: 'PUBLISHED',
      liveRevisionId: '01900000-0000-7000-8000-00000000f001',
      firstPublishedAt: new Date('2026-10-01T00:00:00Z'),
    };
  }),
};
const enrollment = {
  hasAccess: vi.fn(async (userId: string, courseId: string) =>
    enrolled.has(`${userId}:${courseId}`),
  ),
};

/** Gives the test the shared socket.io server (no handlers, so nothing to audit). */
@RealtimeGateway()
class ServerProbe {
  @WebSocketServer() server!: Server;
}

@Module({ providers: [ServerProbe] })
class ServerProbeModule {}

const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
const tickets = new InMemoryWsTicketStore();
const sessions = new FakeSessionRevocations();
const limiter = new InMemoryConnectionLimiter();

describe('NotificationsGateway (real AppModule, socket.io client)', () => {
  let app: NestExpressApplication;
  let url: string;
  const opened: ClientSocket[] = [];

  function connect(grant: WsTicketGrant): Promise<ClientSocket> {
    return tickets.issue(grant).then(
      ({ ticket }) =>
        new Promise((resolve, reject) => {
          const socket = io(url, {
            path: REALTIME_SOCKET_PATH,
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            auth: { ticket },
            extraHeaders: { origin: ORIGIN },
          });
          opened.push(socket);
          socket.once('connect', () => resolve(socket));
          socket.once('connect_error', (error: Error) => reject(error));
        }),
    );
  }

  function ack(socket: ClientSocket, event: string, body: unknown): Promise<CourseRoomAck> {
    return socket.emitWithAck(event, body) as Promise<CourseRoomAck>;
  }

  function roomsOf(socket: ClientSocket): Set<string> {
    const server = app.get(ServerProbe, { strict: false }).server;
    return server.of('/').sockets.get(socket.id ?? '')?.rooms ?? new Set();
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ServerProbeModule] })
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
      .overrideProvider(CatalogFacade)
      .useValue(catalog)
      .overrideProvider(EnrollmentFacade)
      .useValue(enrollment)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
    catalogDown = false;
    sessions.revoked.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is registered as a @RealtimeGateway of the app', () => {
    expect(app.get(NotificationsGateway, { strict: false })).toBeInstanceOf(NotificationsGateway);
  });

  it('an enrolled learner joins the course room; the server sees it', async () => {
    const socket = await connect(studentGrant());

    await expect(ack(socket, 'subscribe', { courseId: COURSE })).resolves.toEqual({ ok: true });
    expect(roomsOf(socket).has(realtimeCourseRoom(COURSE))).toBe(true);

    // Idempotent, and uppercase ids map to the canonical room.
    await expect(ack(socket, 'subscribe', { courseId: COURSE.toUpperCase() })).resolves.toEqual({
      ok: true,
    });
    expect([...roomsOf(socket)].filter((r) => r.startsWith('c:'))).toEqual([
      realtimeCourseRoom(COURSE),
    ]);
  });

  it('refuses a stranger, an unknown course and a failing check (forbidden)', async () => {
    const socket = await connect(studentGrant());

    await expect(ack(socket, 'subscribe', { courseId: course(7) })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    await expect(ack(socket, 'subscribe', { courseId: UNKNOWN })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    catalogDown = true;
    await expect(ack(socket, 'subscribe', { courseId: COURSE })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect([...roomsOf(socket)].some((r) => r.startsWith('c:'))).toBe(false);
  });

  it('answers invalid for a malformed body', async () => {
    const socket = await connect(studentGrant());
    for (const body of [{}, { courseId: 'c:1' }, 'x', null]) {
      await expect(ack(socket, 'subscribe', body)).resolves.toEqual({
        ok: false,
        error: 'invalid',
      });
    }
    await expect(ack(socket, 'unsubscribe', {})).resolves.toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('admits the owner in the instructor app, but not a learner token of another user', async () => {
    const owner = await connect(
      studentGrant({ userId: OWNER, app: 'instructor', roles: ['STUDENT', 'INSTRUCTOR'] }),
    );
    await expect(ack(owner, 'subscribe', { courseId: COURSE })).resolves.toEqual({ ok: true });

    // An instructor-app token passes on owned courses only, even with an enrollment.
    const otherInstructor = await connect(
      studentGrant({ app: 'instructor', roles: ['STUDENT', 'INSTRUCTOR'] }),
    );
    await expect(ack(otherInstructor, 'subscribe', { courseId: COURSE })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('admits an admin with course:read:any only', async () => {
    const admin = await connect(
      studentGrant({
        userId: ADMIN,
        app: 'admin',
        roles: ['STUDENT', 'ADMIN'],
        permissions: ['course:read:any'],
      }),
    );
    await expect(ack(admin, 'subscribe', { courseId: course(12) })).resolves.toEqual({ ok: true });

    const bare = await connect(
      studentGrant({ userId: ADMIN, app: 'admin', roles: ['STUDENT', 'ADMIN'], permissions: [] }),
    );
    await expect(ack(bare, 'subscribe', { courseId: course(12) })).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('caps a socket at 5 course rooms; unsubscribe frees a slot', async () => {
    const socket = await connect(studentGrant());
    for (const n of [1, 2, 3, 4, 5]) {
      await expect(ack(socket, 'subscribe', { courseId: course(n) })).resolves.toEqual({
        ok: true,
      });
    }
    await expect(ack(socket, 'subscribe', { courseId: course(6) })).resolves.toEqual({
      ok: false,
      error: 'too_many_rooms',
    });
    await expect(ack(socket, 'subscribe', { courseId: course(5) })).resolves.toEqual({ ok: true });

    await expect(ack(socket, 'unsubscribe', { courseId: course(5) })).resolves.toEqual({
      ok: true,
    });
    await expect(ack(socket, 'subscribe', { courseId: course(6) })).resolves.toEqual({ ok: true });
    expect([...roomsOf(socket)].filter((r) => r.startsWith('c:'))).toHaveLength(
      REALTIME_LIMITS.maxCourseRoomsPerSocket,
    );
  });

  it('parallel subscribes cannot pass the cap together', async () => {
    const socket = await connect(studentGrant());
    const acks = await Promise.all(
      [1, 2, 3, 4, 5, 6, 8].map((n) => ack(socket, 'subscribe', { courseId: course(n) })),
    );
    expect(acks.filter((a) => a.ok)).toHaveLength(REALTIME_LIMITS.maxCourseRoomsPerSocket);
    expect(acks.filter((a) => !a.ok)).toEqual([
      { ok: false, error: 'too_many_rooms' },
      { ok: false, error: 'too_many_rooms' },
    ]);
    expect([...roomsOf(socket)].filter((r) => r.startsWith('c:'))).toHaveLength(
      REALTIME_LIMITS.maxCourseRoomsPerSocket,
    );
  });

  it('the revocation sweep closes the sockets of a session revoked after the handshake', async () => {
    const revokedGrant = studentGrant({ sessionId: '01900000-0000-7000-8000-00000000b0aa' });
    const victim = await connect(revokedGrant);
    const bystander = await connect(studentGrant());
    const closed = new Promise<string>((resolve) => victim.once('disconnect', resolve));
    sessions.revoked.add(revokedGrant.sessionId);

    const adapter = realtimeAdapterOf(app);
    expect(adapter).toBeDefined();
    await expect(adapter?.revocationSweep.sweep()).resolves.toBe(1);

    await expect(closed).resolves.toBe('io server disconnect');
    expect(bystander.connected).toBe(true);
  });
});
