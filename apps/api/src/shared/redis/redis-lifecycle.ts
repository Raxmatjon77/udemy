import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { InjectRedis } from './inject-redis.decorator';
import type { RedisClient } from './redis.constants';

/**
 * Connects the Redis client at startup and closes it on shutdown
 * (needs `app.enableShutdownHooks()`).
 *
 * Startup does NOT fail when Redis is down: ioredis keeps reconnecting, `/health/ready`
 * answers 503 so k8s withholds traffic, and requests that need Redis fail closed with 503.
 */
@Injectable()
export class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisLifecycle.name);

  constructor(@InjectRedis() private readonly redis: RedisClient) {}

  async onModuleInit(): Promise<void> {
    if (this.redis.status !== 'wait') return;
    try {
      await this.redis.connect();
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis not reachable at startup; retrying in background');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    try {
      // QUIT lets in-flight commands finish; it fails when not connected.
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
    this.logger.log('Redis connection closed');
  }
}
