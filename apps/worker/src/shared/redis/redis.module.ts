import { Global, Module } from '@nestjs/common';
import { WorkerConfigService } from '../config';
import { createRedisClient } from './create-redis-client';
import { REDIS, type RedisClient } from './redis.constants';
import { RedisLifecycle } from './redis-lifecycle';

/**
 * The worker's single ioredis client (`REDIS_URL`, the api's instance). Global: the realtime
 * emitter (and any later Redis user) injects it with `@InjectRedis()`.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [WorkerConfigService],
      useFactory: (config: WorkerConfigService): RedisClient =>
        createRedisClient(config.get('REDIS_URL')),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
