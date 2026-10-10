import { Injectable, Logger } from '@nestjs/common';
import { type HealthIndicatorResult, indicatorResult } from '@udemy/nest-common';
import { InjectRedis } from './inject-redis.decorator';
import type { RedisClient } from './redis.constants';

/**
 * Readiness check: is the client connected and does PING answer in time?
 * Usage with terminus: `this.health.check([() => this.redis.check('redis')])`.
 */
@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(@InjectRedis() private readonly redis: RedisClient) {}

  async check<TKey extends string>(key: TKey): Promise<HealthIndicatorResult<TKey>> {
    if (this.redis.status !== 'ready') {
      return indicatorResult(key, 'down', { message: 'Redis is unreachable' });
    }
    const startedAt = performance.now();
    try {
      // Bounded by the client's commandTimeout.
      await this.redis.ping();
      return indicatorResult(key, 'up', {
        responseTimeMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis health check failed');
      return indicatorResult(key, 'down', { message: 'Redis is unreachable' });
    }
  }
}
