import { Injectable } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import {
  parseRealtimeServerEvent,
  type RealtimeServerEvent,
  type RealtimeServerEventPayload,
} from '@udemy/contracts';
import { InjectRedis, type RedisClient, withRedis } from '../redis';

/** The only Redis command `@socket.io/redis-emitter` uses. */
interface PublishSink {
  publish(channel: string, message: string | Buffer): Promise<number>;
}

/**
 * Api-side realtime pushes (design §3 `RealtimeEmitter`), e.g. a course-room `qa.changed` hint
 * after a Q&A post committed. Publishes through Redis exactly like the worker's emitter, so it
 * reaches the sockets of every replica, and works on a replica that hosts no socket.
 *
 * Unlike the raw emitter (fire-and-forget), every call resolves once Redis accepted the publish
 * and rejects with `RedisUnavailableError` otherwise; callers decide whether a lost hint
 * matters (it usually does not: clients refetch on reconnect). Payloads are validated against
 * the contract (ids only).
 */
@Injectable()
export class RealtimeEmitter {
  constructor(@InjectRedis() private readonly redis: RedisClient) {}

  /** Emits `event` to every socket in `room` (e.g. `realtimeCourseRoom(courseId)`). */
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

  /** Makes every socket in `fromRoom` leave `rooms` (e.g. a revoked learner's course room). */
  socketsLeave(fromRoom: string, rooms: readonly string[]): Promise<void> {
    return this.publishing((emitter) => {
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
    await withRedis(() => Promise.all(pending));
  }
}
