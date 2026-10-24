import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { AuthMetadataReader, getClientContext, setPrincipal } from '../../../../shared/auth';
import { classifyGuardContext } from '../../../../shared/realtime';
import { AccessTokenAuthenticator } from '../../application/access-token.authenticator';
import { Unauthenticated } from '../../domain/identity.errors';
import { readBearerToken } from './bearer-token';

/**
 * Global guard #3 (design §1, after ClientAuthGuard and the throttler): authenticates the end
 * user from `Authorization: Bearer <access token>`.
 *
 * - `@Public()` routes never reject. A valid token from the authenticated client still sets the
 *   principal (optional auth); any failure, including Redis being down, is ignored.
 * - Every other route (including misconfigured ones, which PoliciesGuard then denies) needs a
 *   valid token issued to the calling client's app and a non-revoked session:
 *   401 `token_expired` / 401 `unauthorized` / 503 `service_unavailable` (Redis down).
 *
 * WebSocket (Phase 5 design §9): the user of a socket was authenticated once, at the handshake
 * (single-use ticket + session revocation check, `RealtimeConnectionAuth`), and the socket is
 * closed after 15 minutes. A `@RealtimeGateway` handler on such a socket passes; every other
 * non-HTTP context is denied.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reader: AuthMetadataReader,
    private readonly authenticator: AccessTokenAuthenticator,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const context = classifyGuardContext(ctx);
    if (context.kind === 'denied') return false;
    if (context.kind === 'realtime') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const bearer = readBearerToken(req);
    // Tokens are bound to a client app: without an authenticated client there is no user.
    const client = getClientContext(req);

    if (this.reader.forContext(ctx).security.kind === 'public') {
      if (bearer.kind === 'present' && client !== undefined) {
        try {
          setPrincipal(req, await this.authenticator.authenticate(bearer.token, client));
        } catch (error) {
          this.logger.debug({ err: error }, 'Ignoring invalid optional access token');
        }
      }
      return true;
    }

    if (bearer.kind !== 'present' || client === undefined) throw new Unauthenticated();
    setPrincipal(req, await this.authenticator.authenticate(bearer.token, client));
    return true;
  }
}
