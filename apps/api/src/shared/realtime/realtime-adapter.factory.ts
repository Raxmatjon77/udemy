import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import { AppConfigService } from '../config';
import { createRedisClient, type RedisClient } from '../redis';

/** The socket.io `adapter` server option; undefined = socket.io's in-memory adapter. */
export type RealtimeAdapterConstructor = ServerOptions['adapter'] | undefined;

/**
 * Builds the socket.io adapter of the realtime server. A port so tests without Redis can run
 * the real server with the in-memory adapter (`InMemoryRealtimeAdapterFactory`).
 */
export abstract class RealtimeAdapterFactory {
  /** Called when the socket.io server is created (only if a `@RealtimeGateway` exists). */
  abstract create(): RealtimeAdapterConstructor;

  /** Closes what `create` opened. Idempotent. */
  abstract close(): Promise<void>;
}

/** Single-process adapter for tests (no cross-replica fan-out, no worker emitter). */
export class InMemoryRealtimeAdapterFactory extends RealtimeAdapterFactory {
  create(): RealtimeAdapterConstructor {
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Fire-and-forget commands of the Redis adapter: it calls them without handling the returned
 * promise, so a rejection (Redis down: the publisher fails fast) would be an unhandled rejection,
 * which terminates Node. The rejection is logged instead; socket.io's own semantics already
 * accept that a broadcast during an outage is lost (the WS messages are only invalidation hints).
 */
const UNAWAITED_COMMANDS = ['publish', 'psubscribe', 'subscribe', 'punsubscribe', 'unsubscribe'];

export function guardUnawaitedCommands(client: RedisClient, logger: Logger): void {
  for (const name of UNAWAITED_COMMANDS) {
    const original: unknown = Reflect.get(client, name);
    if (typeof original !== 'function') continue;
    const guarded = (...args: unknown[]): unknown => {
      const result: unknown = Reflect.apply(original, client, args);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          logger.warn({ err: error, command: name }, 'Realtime Redis command failed');
        });
      }
      return result;
    };
    Reflect.set(client, name, guarded);
  }
}

/**
 * `@socket.io/redis-adapter` (design D15): every api replica shares broadcasts and room
 * operations through Redis pub/sub, and the worker's `@socket.io/redis-emitter` reaches the
 * sockets of every replica the same way (same Redis, same default `socket.io` channel prefix).
 *
 * Two dedicated connections (a subscriber cannot run other commands), opened lazily:
 * - publisher: the api's fail-fast settings (no offline queue, 1 s command timeout);
 * - subscriber: queues its SUBSCRIBEs until connected and never gives up on them
 *   (`maxRetriesPerRequest: null`), so the api boots while Redis is down and ioredis
 *   re-subscribes after every reconnect.
 */
@Injectable()
export class RedisRealtimeAdapterFactory
  extends RealtimeAdapterFactory
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(RedisRealtimeAdapterFactory.name);
  private clients: { readonly pub: RedisClient; readonly sub: RedisClient } | undefined;

  constructor(private readonly config: AppConfigService) {
    super();
  }

  create(): RealtimeAdapterConstructor {
    this.clients ??= this.connect();
    return createAdapter(this.clients.pub, this.clients.sub);
  }

  async close(): Promise<void> {
    const clients = this.clients;
    this.clients = undefined;
    if (clients === undefined) return;
    await Promise.all([quit(clients.pub), quit(clients.sub)]);
    this.logger.log('Realtime Redis connections closed');
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }

  private connect(): { pub: RedisClient; sub: RedisClient } {
    const url = this.config.get('REDIS_URL');
    const pub = createRedisClient({
      url,
      connectionName: 'udemy-api-realtime-pub',
      overrides: { lazyConnect: false },
    });
    const sub = createRedisClient({
      url,
      connectionName: 'udemy-api-realtime-sub',
      overrides: {
        lazyConnect: false,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        autoResubscribe: true,
      },
    });
    guardUnawaitedCommands(pub, this.logger);
    guardUnawaitedCommands(sub, this.logger);
    return { pub, sub };
  }
}

async function quit(client: RedisClient): Promise<void> {
  if (client.status === 'end') return;
  // QUIT on a client that is not connected would wait in the subscriber's offline queue.
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
