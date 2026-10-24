import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { RedisClient } from './redis.constants';

export const REDIS_COMMAND_TIMEOUT_MS = 1_000;
export const REDIS_CONNECT_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * The worker's ioredis client, with the api's fail-fast settings: no offline queue (a command
 * while disconnected rejects at once), a 1 s command timeout, endless capped reconnects, and a
 * lazy connect (RedisLifecycle connects at startup without blocking it). A Kafka handler must
 * never hang on Redis: realtime pushes are best-effort hints after the commit.
 */
export function createRedisClient(url: string): RedisClient {
  const logger = new Logger('Redis');
  const client = new Redis(url, {
    connectionName: 'udemy-worker',
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });
  // Log transitions only, not one line per reconnect attempt.
  let healthy = true;
  client.on('ready', () => {
    healthy = true;
    logger.log('Redis connection ready');
  });
  client.on('error', (error: Error) => {
    if (!healthy) return;
    healthy = false;
    logger.error(
      { err: error },
      'Redis connection error; reconnecting (realtime pushes are skipped)',
    );
  });
  return client;
}
