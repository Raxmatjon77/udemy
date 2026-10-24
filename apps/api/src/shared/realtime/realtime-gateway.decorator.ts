import { applyDecorators, SetMetadata } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import { REALTIME_SOCKET_PATH, REALTIME_TRANSPORTS } from '@udemy/contracts';

/** Class metadata key of `@RealtimeGateway()`. */
export const REALTIME_GATEWAY_METADATA = 'udemy:realtime-gateway';

export interface RealtimeGatewayOptions {
  /** socket.io namespace (default `/`). Every namespace gets the same handshake checks. */
  readonly namespace?: string;
}

/**
 * The only way to declare a socket.io gateway in the api (Phase 5 learning experience design
 * D15, D16, §9):
 *
 *   @RealtimeGateway()
 *   export class NotificationsGateway {
 *     @SubscribeMessage('subscribe')
 *     @AuthenticatedOnly()
 *     subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) { ... }
 *   }
 *
 * - The gateway shares the HTTP server (port 0) at `REALTIME_SOCKET_PATH`, WebSocket transport
 *   only. `RedisIoAdapter` enforces these server options whatever a gateway declares.
 * - Every connection was authenticated by the adapter's handshake middleware (single-use ticket,
 *   Origin allowlist, session revocation, connection cap) before any handler runs; handlers read
 *   it with `getRealtimeIdentity(socket)`.
 * - The global guards (ClientAuthGuard, ThrottlerGuard, JwtAuthGuard, PoliciesGuard) allow a
 *   `ws` handler only inside a class carrying this marker, and only for an authenticated socket.
 * - Every `@SubscribeMessage` handler needs a security marker (`@AuthenticatedOnly` or
 *   `@RequirePermissions`); `RouteSecurityAuditor` fails boot otherwise, and also when a plain
 *   `@WebSocketGateway` or a stray `@SubscribeMessage` exists anywhere.
 */
export function RealtimeGateway(options: RealtimeGatewayOptions = {}): ClassDecorator {
  return applyDecorators(
    WebSocketGateway(0, {
      path: REALTIME_SOCKET_PATH,
      transports: [...REALTIME_TRANSPORTS],
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    }),
    SetMetadata(REALTIME_GATEWAY_METADATA, true),
  );
}

/** True for a class decorated with `@RealtimeGateway()`. */
export function isRealtimeGateway(target: unknown): boolean {
  return (
    typeof target === 'function' && Reflect.getMetadata(REALTIME_GATEWAY_METADATA, target) === true
  );
}
