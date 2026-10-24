import type { INestApplication } from '@nestjs/common';
import { RealtimeAdapterFactory } from './realtime-adapter.factory';
import { RealtimeConnectionAuth } from './realtime-connection.auth';
import { RedisIoAdapter } from './redis-io.adapter';

const installed = new WeakSet<INestApplication>();

/**
 * Installs the api's socket.io adapter (`RedisIoAdapter`): the ONE place that does it, called by
 * `setupApp`, which `main.ts`, the e2e harness and every HTTP test that boots the app share
 * (design §13 item 2). Must run before `app.init()` / `app.listen()`. Idempotent.
 *
 * Opens no connection by itself: the socket.io server, and with it the Redis adapter's
 * connections, exist only once a `@RealtimeGateway` is registered.
 */
export function installRealtimeAdapter(app: INestApplication): void {
  if (installed.has(app)) return;
  app.useWebSocketAdapter(
    new RedisIoAdapter(app, {
      auth: app.get(RealtimeConnectionAuth, { strict: false }),
      adapterFactory: app.get(RealtimeAdapterFactory, { strict: false }),
    }),
  );
  installed.add(app);
}
