import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { ClientApp } from '@udemy/contracts';
import type { Request } from 'express';
import {
  AuthMetadataReader,
  ClientIpResolver,
  markClientAuthenticated,
  setClientContext,
} from '../../../../shared/auth';
import { AppConfigService } from '../../../../shared/config';
import { classifyGuardContext, type RealtimeIdentity } from '../../../../shared/realtime';
import { ClientNotAllowed, Unauthenticated } from '../../domain/identity.errors';
import {
  CLIENT_ID_HEADER,
  CLIENT_IDS,
  CLIENT_SECRET_HEADER,
  type ClientId,
  isClientId,
  singleHeader,
} from './client-credentials';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Global guard #1 (design §1): authenticates the calling BFF with `X-Client-Id` +
 * `X-Client-Secret`. The API only knows `sha256(secret)` per app and compares digests in
 * constant time.
 *
 * - `@NoClientAuth()` routes: skipped (probes, JWKS).
 * - Missing/unknown id or wrong secret: 401 `unauthorized`.
 * - Authenticated, but the route has `@AllowClients(...)` without this app: 403 `client_not_allowed`.
 * - Success: the request becomes client-authenticated BEFORE the end-user IP/UA are resolved,
 *   so `X-Client-IP` / `X-Client-User-Agent` are trusted only from a verified BFF.
 *
 * WebSocket (Phase 5 design §9): a socket has no client credentials; its app was fixed by the
 * BFF-authenticated request that issued its ticket. A `@RealtimeGateway` handler on an
 * authenticated socket passes (honouring `@AllowClients` against that app); every other
 * non-HTTP context is denied.
 */
@Injectable()
export class ClientAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClientAuthGuard.name);
  /** Compared against for unknown client ids, so they cost the same as a wrong secret. */
  private readonly dummyDigest = randomBytes(32);

  constructor(
    private readonly reader: AuthMetadataReader,
    private readonly ipResolver: ClientIpResolver,
    private readonly config: AppConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const context = classifyGuardContext(ctx);
    if (context.kind === 'denied') return false;
    if (context.kind === 'realtime') return this.allowsRealtime(ctx, context.identity);
    const { client: access } = this.reader.forContext(ctx);
    if (access.kind === 'none') return true;
    // @NoClientAuth together with @AllowClients: the route auditor fails boot; deny meanwhile.
    if (access.kind === 'conflict') throw new ClientNotAllowed();

    const req = ctx.switchToHttp().getRequest<Request>();
    const clientId = singleHeader(req, CLIENT_ID_HEADER);
    const secret = singleHeader(req, CLIENT_SECRET_HEADER);
    const app = this.authenticate(clientId, secret);
    if (app === undefined || clientId === undefined) {
      this.logger.debug({ clientId: clientId ?? null }, 'Client authentication failed');
      throw new Unauthenticated();
    }

    markClientAuthenticated(req);
    setClientContext(req, {
      clientId,
      app,
      ip: this.ipResolver.resolve(req),
      userAgent: this.ipResolver.resolveUserAgent(req),
    });

    if (access.kind === 'restricted' && !access.apps.includes(app)) {
      throw new ClientNotAllowed();
    }
    return true;
  }

  /** A gateway handler: the socket's app must be allowed; `@NoClientAuth` makes no sense here. */
  private allowsRealtime(ctx: ExecutionContext, identity: RealtimeIdentity): boolean {
    const { client: access } = this.reader.forContext(ctx);
    if (access.kind === 'any') return true;
    if (access.kind === 'restricted') return access.apps.includes(identity.principal.app);
    // 'none' / 'conflict': RouteSecurityAuditor fails boot for these on a gateway; deny meanwhile.
    return false;
  }

  /** The app of valid credentials, else undefined. Always does one hash + one comparison. */
  private authenticate(
    clientId: string | undefined,
    secret: string | undefined,
  ): ClientApp | undefined {
    const app =
      clientId !== undefined && isClientId(clientId) ? CLIENT_IDS[clientId as ClientId] : undefined;
    const expected =
      app === undefined ? this.dummyDigest : Buffer.from(this.config.clientSecretHash(app), 'hex');
    const presented = sha256(secret ?? '');
    const match = expected.length === presented.length && timingSafeEqual(expected, presented);
    return match && secret !== undefined ? app : undefined;
  }
}
