import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis, type RedisClient } from '../../../shared/redis';
import { AccessCache } from '../application/ports/access-cache';

/** Design §6: `lrn:acc:{u}:{c}` = 1 | 0, 60 s. */
export const ACCESS_CACHE_TTL_SECONDS = 60;

export function accessCacheKey(userId: string, courseId: string): string {
  return `lrn:acc:${userId.toLowerCase()}:${courseId.toLowerCase()}`;
}

/**
 * The heartbeat's access cache in Redis. A failure is a miss (get) or ignored (set): the
 * caller then asks enrollment, so an outage never grants access and never fails a request
 * by itself.
 */
@Injectable()
export class RedisAccessCache extends AccessCache {
  private readonly logger = new Logger(RedisAccessCache.name);

  constructor(@InjectRedis() private readonly redis: RedisClient) {
    super();
  }

  async get(userId: string, courseId: string): Promise<boolean | null> {
    try {
      const value = await this.redis.get(accessCacheKey(userId, courseId));
      if (value === '1') return true;
      if (value === '0') return false;
      return null;
    } catch (error) {
      this.logger.warn({ err: error }, 'access cache read failed; asking enrollment');
      return null;
    }
  }

  async set(userId: string, courseId: string, hasAccess: boolean): Promise<void> {
    try {
      await this.redis.set(
        accessCacheKey(userId, courseId),
        hasAccess ? '1' : '0',
        'EX',
        ACCESS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'access cache write failed');
    }
  }
}
