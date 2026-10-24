import { Injectable } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import {
  parseRealtimeServerEvent,
  type RealtimeServerEvent,
  type RealtimeServerEventPayload,
} from '@udemy/contracts';
import { InjectRedis, type RedisClient } from '../redis';

/** A realtime push could not be published (Redis down or slow). */
export class RealtimePushError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('Realtime push failed', { cause: options.cause });
    this.name = 'RealtimePushError';
  }
}

/** The only Redis command `@socket.io/redis-emitter` uses. */
interface PublishSink {
  publish(channel: string, message: string | Buffer): Promise<number>;
}

/**
 * Pushes WS invalidation hints from the worker to the api's sockets (design D15, D17) through
 * `@socket.io/redis-emitter`: the api's socket.io Redis adapter subscribes to the same Redis
 * channels (default `socket.io` prefix, namespace `/`), so every api replica delivers it.
 *
 * Call it from an `afterCommit` task (`HandlerContext.afterCommit`), never inside the claim
 * transaction: a hint must not announce a row that may still roll back. Unlike the raw emitter
 * (fire-and-forget), each call resolves once Redis accepted the publish and rejects with
 * `RealtimePushError` otherwise. Payloads are validated against the contract (ids only).
 *
 *   ctx.afterCommit(() =>
 *     this.realtime.emit(realtimeUserRoom(userId, 'STUDENT'), 'notification.created', { id, kind, app }),
 *   );
 */
@Injectable()
export class RealtimeEmitter {
  constructor(@InjectRedis() private readonly redis: RedisClient) {}

  /** Emits `event` to every socket in `room` (`realtimeUserRoom` / `realtimeCourseRoom`). */
  async emit<E extends RealtimeServerEvent>(
    room: string,
    event: E,
    payload: RealtimeServerEventPayload<E>,
  ): Promise<void> {
    const data = parseRealtimeServerEvent(event, payload);
    await this.publishing((emitter) => {
      emitter.to(room).emit(event, data);
    });
  }

  /**
   * Makes every socket in `fromRoom` leave `rooms`, on every api replica (design D17: a revoked
   * learner leaves the course room). Verified for @socket.io/redis-emitter 5.1.0 with
   * @socket.io/redis-adapter 8.3.0: a `REMOTE_LEAVE` request (JSON, `socket.io-request#/#`)
   * that each adapter applies locally with `delSockets`. Like any pub/sub message it is lost
   * for a replica disconnected from Redis at that moment.
   */
  async socketsLeave(fromRoom: string, rooms: readonly string[]): Promise<void> {
    await this.publishing((emitter) => {
      emitter.in(fromRoom).socketsLeave([...rooms]);
    });
  }

  private async publishing(send: (emitter: Emitter) => void): Promise<void> {
    const pending: Promise<number>[] = [];
    const sink: PublishSink = {
      publish: (channel, message) => {
        const published = this.redis.publish(channel, message);
        pending.push(published);
        return published;
      },
    };
    send(new Emitter(sink));
    try {
      await Promise.all(pending);
    } catch (error) {
      throw new RealtimePushError({ cause: error });
    }
  }
}
