import type { INestApplication } from '@nestjs/common';
import { RealtimeAdapterFactory } from './realtime-adapter.factory';
import { RealtimeConnectionAuth } from './realtime-connection.auth';
import {
  REALTIME_SESSION_REVOCATIONS,
  type RealtimeSessionRevocations,
} from './realtime-session-revocations';
import { RedisIoAdapter } from './redis-io.adapter';

const installed = new WeakMap<INestApplication, RedisIoAdapter>();

/**
 * Installs the api's socket.io adapter (`RedisIoAdapter`): the ONE place that does it, called by
 * `setupApp`, which `main.ts`, the e2e harness and every HTTP test that boots the app share
 * (design §13 item 2). Must run before `app.init()` / `app.listen()`. Idempotent.
 *
 * Opens no connection by itself: the socket.io server, and with it the Redis adapter's
 * connections, exist only once a `@RealtimeGateway` is registered.
 */
export function installRealtimeAdapter(app: INestApplication): RedisIoAdapter {
  const existing = installed.get(app);
  if (existing !== undefined) return existing;
  const adapter = new RedisIoAdapter(app, {
    auth: app.get(RealtimeConnectionAuth, { strict: false }),
    adapterFactory: app.get(RealtimeAdapterFactory, { strict: false }),
    sessions: app.get<unknown, RealtimeSessionRevocations>(REALTIME_SESSION_REVOCATIONS, {
      strict: false,
    }),
  });
  app.useWebSocketAdapter(adapter);
  installed.set(app, adapter);
  return adapter;
}

/** The adapter `installRealtimeAdapter` installed on `app` (tests drive its revocation sweep). */
export function realtimeAdapterOf(app: INestApplication): RedisIoAdapter | undefined {
  return installed.get(app);
}
