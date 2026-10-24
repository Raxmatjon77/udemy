import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { IssueRealtimeTicket } from './issue-realtime-ticket';
import { RealtimeAdapterFactory, RedisRealtimeAdapterFactory } from './realtime-adapter.factory';
import { RealtimeConnectionAuth } from './realtime-connection.auth';
import {
  RealtimeConnectionLimiter,
  RedisRealtimeConnectionLimiter,
} from './realtime-connection.limiter';
import { RealtimeEmitter } from './realtime-emitter';
import { REALTIME_SESSION_REVOCATIONS } from './realtime-session-revocations';
import { RealtimeTicketsController } from './realtime-tickets.controller';
import { RedisWsTicketStore } from './redis-ws-ticket.store';
import { WsTicketStore } from './ws-ticket.store';

export interface RealtimeModuleOptions {
  /** Modules that export `sessionRevocations` (the identity module facade). */
  readonly imports?: ModuleMetadata['imports'];
  /**
   * The provider that answers "is this session revoked?" (`RealtimeSessionRevocations`), chosen
   * by AppModule so `shared/realtime` imports no bounded context:
   * `RealtimeModule.forRoot({ imports: [IdentityModule], sessionRevocations: SessionRevocationStore })`.
   */
  readonly sessionRevocations: InjectionToken;
}

/**
 * The realtime plumbing (design §3 `src/shared/realtime`, D15–D17): the WS ticket route and
 * store, the handshake authentication, the socket.io Redis adapter factory and the api-side
 * emitter. Global, so gateways (P5-T14 `NotificationsGateway`) and post-commit pushes inject
 * them without importing this module. `installRealtimeAdapter(app)` (via `setupApp`) wires the
 * adapter into the app. Needs the global AppConfigModule and RedisModule.
 */
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions): DynamicModule {
    return {
      module: RealtimeModule,
      global: true,
      imports: options.imports ?? [],
      controllers: [RealtimeTicketsController],
      providers: [
        { provide: REALTIME_SESSION_REVOCATIONS, useExisting: options.sessionRevocations },
        { provide: WsTicketStore, useClass: RedisWsTicketStore },
        { provide: RealtimeConnectionLimiter, useClass: RedisRealtimeConnectionLimiter },
        RedisRealtimeAdapterFactory,
        { provide: RealtimeAdapterFactory, useExisting: RedisRealtimeAdapterFactory },
        RealtimeConnectionAuth,
        IssueRealtimeTicket,
        RealtimeEmitter,
      ],
      exports: [RealtimeConnectionAuth, RealtimeAdapterFactory, RealtimeEmitter, WsTicketStore],
    };
  }
}
