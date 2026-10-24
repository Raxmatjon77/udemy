import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { InjectRedis, type RedisClient } from './redis.constants';

/**
 * Connects the Redis client at startup and closes it on shutdown. Startup does NOT fail when
 * Redis is down: ioredis keeps reconnecting and the realtime pushes fail (logged) meanwhile.
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
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
    this.logger.log('Redis connection closed');
  }
}
