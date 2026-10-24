import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { classifyGuardContext } from '../realtime/realtime-guard-context';

/**
 * Global guard #2 (`ThrottlerGuard`, per-client-IP limit) with the realtime rule of the Phase 5
 * design §9 "Global guards":
 *
 * - HTTP: the library guard, unchanged.
 * - A handler of a `@RealtimeGateway` on an authenticated socket: allowed. Socket messages are
 *   limited per socket by `RedisIoAdapter` (`REALTIME_LIMITS.maxInboundPerMinute`, then
 *   disconnect) and the handshake by the per-user ticket limit; the IP tracker of this guard
 *   reads HTTP request fields a socket does not have.
 * - Any other non-HTTP context: denied.
 */
@Injectable()
export class RealtimeAwareThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = classifyGuardContext(context).kind;
    if (kind === 'denied') return false;
    if (kind === 'realtime') return true;
    return super.canActivate(context);
  }
}
