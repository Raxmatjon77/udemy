import { Injectable } from '@nestjs/common';
import { REALTIME_LIMITS } from '@udemy/contracts';
import { InjectRedis, type RedisClient, withRedis } from '../redis';

/** `ws:conn:{userId}`: live sockets of a user across replicas (design §6 "Redis keys"). */
export function wsConnectionKey(userId: string): string {
  return `ws:conn:${userId}`;
}

/**
 * The counter's TTL (20 min) outlives the longest connection (15 min) and is refreshed by every
 * connect, so counts that a crashed replica never released heal by themselves.
 */
export const WS_CONNECTION_COUNTER_TTL_SECONDS = 20 * 60;

/** At most `REALTIME_LIMITS.maxSocketsPerUser` sockets per user (design D16). */
export abstract class RealtimeConnectionLimiter {
  /** Counts one more socket; false (and nothing counted) when the user is at the cap. */
  abstract acquire(userId: string): Promise<boolean>;

  /** Releases a socket counted by `acquire`. */
  abstract release(userId: string): Promise<void>;
}

/** KEYS[1] = counter, ARGV[1] = cap, ARGV[2] = ttl seconds. Returns 1 (acquired) or 0. */
const ACQUIRE = [
  "local count = redis.call('INCR', KEYS[1])",
  "redis.call('EXPIRE', KEYS[1], ARGV[2])",
  'if count > tonumber(ARGV[1]) then',
  "  redis.call('DECR', KEYS[1])",
  '  return 0',
  'end',
  'return 1',
].join('\n');

/** KEYS[1] = counter. Never leaves a zero or negative counter behind (e.g. after the TTL). */
const RELEASE = [
  "local count = redis.call('DECR', KEYS[1])",
  "if count <= 0 then redis.call('DEL', KEYS[1]) end",
  'return count',
].join('\n');

@Injectable()
export class RedisRealtimeConnectionLimiter extends RealtimeConnectionLimiter {
  constructor(@InjectRedis() private readonly redis: RedisClient) {
    super();
  }

  async acquire(userId: string): Promise<boolean> {
    const reply = await withRedis(() =>
      this.redis.eval(
        ACQUIRE,
        1,
        wsConnectionKey(userId),
        String(REALTIME_LIMITS.maxSocketsPerUser),
        String(WS_CONNECTION_COUNTER_TTL_SECONDS),
      ),
    );
    return reply === 1;
  }

  async release(userId: string): Promise<void> {
    await withRedis(() => this.redis.eval(RELEASE, 1, wsConnectionKey(userId)));
  }
}
