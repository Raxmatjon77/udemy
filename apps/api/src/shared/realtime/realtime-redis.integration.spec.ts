import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  REALTIME_LIMITS,
  REALTIME_SOCKET_PATH,
  realtimeCourseRoom,
  realtimeUserRoom,
} from '@udemy/contracts';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itRedisUrl, useIntegrationRedis } from '../../testing/integration';
import type { AppConfigService } from '../config';
import { RedisRealtimeAdapterFactory } from './realtime-adapter.factory';
import {
  RedisRealtimeConnectionLimiter,
  WS_CONNECTION_COUNTER_TTL_SECONDS,
  wsConnectionKey,
} from './realtime-connection.limiter';
import { RealtimeEmitter } from './realtime-emitter';
import { RedisWsTicketStore, wsTicketKey } from './redis-ws-ticket.store';
import { studentGrant } from './testing/realtime.fakes';

/**
 * The realtime Redis pieces against the integration Redis (IT_REDIS_URL; skipped locally when
 * unreachable, a failure with CI=true):
 *
 * - the ticket store: 30 s TTL, single use under a race (GETDEL);
 * - the connection cap Lua scripts;
 * - design §12 risk "T5": `@socket.io/redis-emitter` (the worker's push path, same wire format as
 *   the api's RealtimeEmitter) reaching a socket.io server that runs the Redis adapter from
 *   `RedisRealtimeAdapterFactory`, including `socketsLeave` for a revoked learner.
 */
describe('realtime Redis (integration)', () => {
  const itRedis = useIntegrationRedis();
  let redis: Redis;
  const userIds: string[] = [];

  beforeAll(() => {
    if (!itRedis.available) return;
    redis = itRedis.redis;
  });

  afterAll(async () => {
    if (!itRedis.available) return;
    const keys = userIds.map(wsConnectionKey);
    if (keys.length > 0) await redis.del(...keys);
  });

  it('tickets live 30 s and work exactly once, even when redeemed in parallel', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const store = new RedisWsTicketStore(redis);
    const grant = studentGrant({ userId: randomUUID() });
    const { ticket } = await store.issue(grant);

    const ttl = await redis.ttl(wsTicketKey(ticket));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REALTIME_LIMITS.ticketTtlSeconds);

    const results = await Promise.all(Array.from({ length: 20 }, () => store.consume(ticket)));
    expect(results.filter((r) => r !== null)).toEqual([grant]);
    await expect(redis.exists(wsTicketKey(ticket))).resolves.toBe(0);
  });

  it('caps live sockets per user atomically and never leaves a negative counter', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const limiter = new RedisRealtimeConnectionLimiter(redis);
    const userId = randomUUID();
    userIds.push(userId);

    const acquired = await Promise.all(
      Array.from({ length: REALTIME_LIMITS.maxSocketsPerUser + 5 }, () => limiter.acquire(userId)),
    );
    expect(acquired.filter(Boolean)).toHaveLength(REALTIME_LIMITS.maxSocketsPerUser);
    await expect(redis.get(wsConnectionKey(userId))).resolves.toBe(
      String(REALTIME_LIMITS.maxSocketsPerUser),
    );
    const ttl = await redis.ttl(wsConnectionKey(userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WS_CONNECTION_COUNTER_TTL_SECONDS);

    for (let i = 0; i < REALTIME_LIMITS.maxSocketsPerUser + 3; i++) await limiter.release(userId);
    await expect(redis.exists(wsConnectionKey(userId))).resolves.toBe(0);
    await expect(limiter.acquire(userId)).resolves.toBe(true);
    await expect(redis.get(wsConnectionKey(userId))).resolves.toBe('1');
  });

  describe('emitter -> Redis adapter', () => {
    let http: HttpServer;
    let server: Server;
    let factory: RedisRealtimeAdapterFactory;
    let client: ClientSocket;
    const userId = randomUUID();
    const courseId = randomUUID();
    const otherCourseId = randomUUID();

    beforeAll(async () => {
      if (!itRedis.available) return;
      factory = new RedisRealtimeAdapterFactory({
        get: () => itRedisUrl(),
      } as unknown as AppConfigService);
      http = createServer();
      server = new Server(http, {
        path: REALTIME_SOCKET_PATH,
        transports: ['websocket'],
        adapter: factory.create(),
      });
      server.on('connection', (socket) => {
        void socket.join([
          realtimeUserRoom(userId, 'STUDENT'),
          realtimeCourseRoom(courseId),
          realtimeCourseRoom(otherCourseId),
        ]);
      });
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
      // The adapter subscribes asynchronously; wait until Redis reports the subscription.
      const requestChannel = 'socket.io-request#/#';
      while (true) {
        const [, subscribers] = (await redis.pubsub('NUMSUB', requestChannel)) as [string, number];
        if (Number(subscribers) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const { port } = http.address() as AddressInfo;
      client = io(`http://127.0.0.1:${port}`, {
        path: REALTIME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    });

    afterAll(async () => {
      if (!itRedis.available) return;
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await factory.close();
    });

    it('delivers a user-room hint published through Redis', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      const emitter = new RealtimeEmitter(redis);
      const received = new Promise<unknown>((resolve) =>
        client.once('notification.unread', resolve),
      );
      await emitter.emit(realtimeUserRoom(userId, 'STUDENT'), 'notification.unread', { count: 3 });
      await expect(received).resolves.toEqual({ count: 3 });
    });

    it('socketsLeave removes the user from a course room on the server, and hints stop', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      const emitter = new RealtimeEmitter(redis);
      const serverSocket = [...server.of('/').sockets.values()][0];
      expect(serverSocket?.rooms.has(realtimeCourseRoom(courseId))).toBe(true);

      await emitter.socketsLeave(realtimeUserRoom(userId, 'STUDENT'), [
        realtimeCourseRoom(courseId),
      ]);
      while (serverSocket?.rooms.has(realtimeCourseRoom(courseId)) === true) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(serverSocket?.rooms.has(realtimeCourseRoom(otherCourseId))).toBe(true);

      // A hint to the left room no longer arrives; one to the other course room still does.
      const seen: unknown[] = [];
      client.on('qa.changed', (payload: unknown) => seen.push(payload));
      const questionId = randomUUID();
      await emitter.emit(realtimeCourseRoom(courseId), 'qa.changed', {
        courseId,
        questionId,
        lectureId: null,
      });
      const marker = new Promise<unknown>((resolve) => client.once('qa.changed', resolve));
      await emitter.emit(realtimeCourseRoom(otherCourseId), 'qa.changed', {
        courseId: otherCourseId,
        questionId,
        lectureId: null,
      });
      await marker;
      expect(seen).toEqual([{ courseId: otherCourseId, questionId, lectureId: null }]);
    });

    it('the adapter clients do not crash the process when a publish fails', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      // Broadcasting through the server publishes via the guarded publisher; a closed publisher
      // rejects, and the rejection must be handled (an unhandled one would fail this file).
      const broken = new RedisRealtimeAdapterFactory({
        get: () => 'redis://127.0.0.1:1',
      } as unknown as AppConfigService);
      const lonely = new Server({ adapter: broken.create(), transports: ['websocket'] });
      lonely.to('nobody').emit('session.reauth', {});
      await new Promise((resolve) => setImmediate(resolve));
      lonely.close();
      await broken.close();
    });
  });
});
