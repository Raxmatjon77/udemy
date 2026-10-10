import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { createRedisClient } from './create-redis-client';
import { RateLimiter } from './rate-limiter';
import { REDIS, type RedisClient } from './redis.constants';
import { RedisHealthIndicator } from './redis-health.indicator';
import { RedisLifecycle } from './redis-lifecycle';

/**
 * Owns the single ioredis client of the api process. Global: identity (revocation keys,
 * rate limits) and the throttler storage use it without importing this module.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): RedisClient =>
        createRedisClient({ url: config.get('REDIS_URL'), connectionName: 'udemy-api' }),
    },
    RedisLifecycle,
    RedisHealthIndicator,
    RateLimiter,
  ],
  exports: [REDIS, RedisHealthIndicator, RateLimiter],
})
export class RedisModule {}
