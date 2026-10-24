import type { ExecutionContext } from '@nestjs/common';
import { isRealtimeGateway } from './realtime-gateway.decorator';
import { type RealtimeIdentity, realtimeIdentityOf } from './realtime-identity';

/**
 * How a global guard must treat an execution context (design §9 "Global guards"):
 *
 * - `http`: the normal HTTP path.
 * - `realtime`: a `@SubscribeMessage` handler of a `@RealtimeGateway` class, on a socket that
 *   passed the handshake checks. The guard evaluates the route markers against `identity`.
 * - `denied`: everything else that is not HTTP (a `ws` handler outside `@RealtimeGateway`, a
 *   socket without identity, `rpc`, …). The guard must refuse.
 */
export type GuardContext =
  | { readonly kind: 'http' }
  | { readonly kind: 'realtime'; readonly identity: RealtimeIdentity }
  | { readonly kind: 'denied'; readonly reason: string };

export function classifyGuardContext(ctx: ExecutionContext): GuardContext {
  const type = ctx.getType<string>();
  if (type === 'http') return { kind: 'http' };
  if (type !== 'ws') return { kind: 'denied', reason: `unsupported execution context '${type}'` };
  if (!isRealtimeGateway(ctx.getClass())) {
    return { kind: 'denied', reason: `${ctx.getClass().name} is not a @RealtimeGateway` };
  }
  const identity = realtimeIdentityOf(ctx.switchToWs().getClient<unknown>());
  if (identity === undefined) return { kind: 'denied', reason: 'unauthenticated socket' };
  return { kind: 'realtime', identity };
}
