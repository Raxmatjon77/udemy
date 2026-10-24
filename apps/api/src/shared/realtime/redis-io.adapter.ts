import { type INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  NOTIFICATION_APP_OF_CLIENT,
  REALTIME_LIMITS,
  REALTIME_SOCKET_PATH,
  REALTIME_TRANSPORTS,
  realtimeUserRoom,
} from '@udemy/contracts';
import { type Namespace, Server, type ServerOptions, type Socket } from 'socket.io';
import type { RealtimeAdapterFactory } from './realtime-adapter.factory';
import { RealtimeConnectError, type RealtimeConnectionAuth } from './realtime-connection.auth';
import { getRealtimeIdentity, setRealtimeIdentity } from './realtime-identity';

export interface RealtimeAdapterDependencies {
  readonly auth: RealtimeConnectionAuth;
  readonly adapterFactory: RealtimeAdapterFactory;
}

/** A namespace must be connected within this time after the WebSocket opened. */
const CONNECT_TIMEOUT_MS = 10_000;
const INBOUND_WINDOW_MS = 60_000;

/**
 * The api's only socket.io adapter (design D15–D17, §9 "WebSocket"; installed by
 * `installRealtimeAdapter`). Whatever a gateway declares, the server:
 *
 * - shares the HTTP server (gateway port 0) at `REALTIME_SOCKET_PATH`;
 * - speaks WebSocket only (no long-polling, so no sticky sessions), no upgrades, no client
 *   bundle, `maxHttpBufferSize` = `REALTIME_LIMITS.maxPayloadBytes`, no connection-state
 *   recovery (a recovered session would skip the handshake middleware);
 * - uses the Redis adapter from `RealtimeAdapterFactory` (cross-replica rooms, worker emitter);
 * - authenticates EVERY namespace's handshake with `RealtimeConnectionAuth` (ticket, Origin,
 *   session, connection cap); a refused handshake gets `connect_error` with the contract code;
 * - on connect: joins the server-assigned user room `u:{userId}:{APP}` (D17), closes the socket
 *   at `expiresAt` after a `session.reauth` hint (15 min cap), and disconnects a socket that
 *   sends more than `maxInboundPerMinute` messages;
 * - on disconnect: releases the user's connection slot.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly deps: RealtimeAdapterDependencies,
  ) {
    super(app);
  }

  /** The enforced server options (exposed for tests). */
  serverOptions(): Partial<ServerOptions> {
    return {
      path: REALTIME_SOCKET_PATH,
      transports: [...REALTIME_TRANSPORTS],
      allowUpgrades: false,
      allowEIO3: false,
      serveClient: false,
      maxHttpBufferSize: REALTIME_LIMITS.maxPayloadBytes,
      connectTimeout: CONNECT_TIMEOUT_MS,
      cleanupEmptyChildNamespaces: true,
    };
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    if (port !== 0) {
      throw new Error(
        `Realtime gateways share the HTTP server: port must be 0 (use @RealtimeGateway), got ${port}`,
      );
    }
    const enforced: Partial<ServerOptions> = { ...this.serverOptions() };
    const adapter = this.deps.adapterFactory.create();
    if (adapter !== undefined) enforced.adapter = adapter;
    // Gateway options first, enforced options last: a gateway cannot widen them. `cors` is
    // dropped: it only applies to HTTP long-polling, which is disabled.
    const gatewayOptions: Partial<ServerOptions> = { ...options };
    delete gatewayOptions.cors;
    const httpServer: unknown = this.httpServer;
    if (httpServer === undefined || httpServer === null) {
      throw new Error(
        'RedisIoAdapter needs the HTTP server: install it with installRealtimeAdapter(app)',
      );
    }
    const server = new Server(httpServer as ConstructorParameters<typeof Server>[0], {
      ...gatewayOptions,
      ...enforced,
    });
    this.secure(server.of('/'));
    server.on('new_namespace', (namespace: Namespace) => this.secure(namespace));
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.deps.adapterFactory.close();
  }

  private secure(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.deps.auth
        .authenticate({ origin: socket.handshake.headers.origin, auth: socket.handshake.auth })
        .then((identity) => {
          setRealtimeIdentity(socket, identity);
          next();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RealtimeConnectError)) {
            this.log.error({ err: error }, 'Unexpected WS handshake failure');
          }
          next(new Error(error instanceof RealtimeConnectError ? error.code : 'ticket_invalid'));
        });
    });
    namespace.on('connection', (socket: Socket) => this.onConnection(socket));
  }

  private onConnection(socket: Socket): void {
    const identity = getRealtimeIdentity(socket);
    if (identity === undefined) {
      // Unreachable: the middleware admits authenticated sockets only.
      socket.disconnect(true);
      return;
    }
    const { principal } = identity;
    void socket.join(realtimeUserRoom(principal.userId, NOTIFICATION_APP_OF_CLIENT[principal.app]));

    const lifetimeMs = Math.max(0, identity.expiresAt.getTime() - Date.now());
    const expiry = setTimeout(() => {
      socket.emit('session.reauth', {});
      socket.disconnect(true);
    }, lifetimeMs);
    expiry.unref();

    let windowStart = Date.now();
    let inbound = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart >= INBOUND_WINDOW_MS) {
        windowStart = now;
        inbound = 0;
      }
      inbound += 1;
      if (inbound > REALTIME_LIMITS.maxInboundPerMinute) {
        this.log.warn(
          { userId: principal.userId },
          'WS inbound rate limit exceeded; disconnecting',
        );
        socket.disconnect(true);
        return;
      }
      next();
    });

    socket.once('disconnect', () => {
      clearTimeout(expiry);
      void this.deps.auth.release(identity);
    });
  }
}
