import { Logger } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import type { RedisClient } from './redis.constants';

export interface CreateRedisClientOptions {
  url: string;
  /** Shown by `CLIENT LIST`, e.g. `udemy-api`. */
  connectionName: string;
  /**
   * Replaces individual defaults below, e.g. for a pub/sub subscriber connection (the socket.io
   * Redis adapter, `shared/realtime`), which must queue its SUBSCRIBEs until connected.
   */
  overrides?: RedisOptions;
}

/** A command that takes longer than this fails (and becomes a 503): a hung Redis must not hang requests. */
export const REDIS_COMMAND_TIMEOUT_MS = 1_000;
export const REDIS_CONNECT_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * Builds the ioredis client with fail-fast settings (design D11, fail closed):
 * - `enableOfflineQueue: false`: while disconnected, commands reject at once instead of
 *   queueing, so requests get a fast 503 rather than waiting for a reconnect.
 * - `commandTimeout`: a stuck command rejects after REDIS_COMMAND_TIMEOUT_MS.
 * - `retryStrategy`: reconnects forever with capped backoff; readiness reports `down` meanwhile.
 * - `lazyConnect`: RedisLifecycle connects in onModuleInit, so creating the provider never blocks.
 */
export function createRedisClient(options: CreateRedisClientOptions): RedisClient {
  const logger = new Logger('Redis');
  const client = new Redis(options.url, {
    connectionName: options.connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
    ...options.overrides,
  });

  // Without an 'error' listener ioredis prints every reconnect failure to stderr. Log only the
  // transitions, not one line per retry.
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
      'Redis connection error; reconnecting (requests needing Redis get 503)',
    );
  });
  return client;
}
