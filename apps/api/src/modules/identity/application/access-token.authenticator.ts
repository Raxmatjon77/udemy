import { Injectable, Logger } from '@nestjs/common';
import type { ClientContext, Principal } from '../../../shared/auth';
import { Unauthenticated } from '../domain/identity.errors';
import { AccessTokenVerifier } from './ports/access-token-verifier';
import { PermissionResolver } from './ports/permission-resolver';
import { SessionRevocationStore } from './ports/session-revocation.store';

/**
 * Turns a Bearer access token into the request's Principal (design §9 "JWT"):
 *
 * 1. verify signature, `iss`, `aud`, expiry (local keys; `token_expired` vs `unauthorized`)
 * 2. `token.app` must equal the authenticated client's app (a token is confined to its BFF)
 * 3. the session must not be revoked in Redis (fail closed: Redis down -> 503)
 * 4. permissions are derived from the token's roles and app, never read from the token
 *
 * Lives in the application layer because step 4 calls the access module, which only
 * application code may import.
 */
@Injectable()
export class AccessTokenAuthenticator {
  private readonly logger = new Logger(AccessTokenAuthenticator.name);

  constructor(
    private readonly verifier: AccessTokenVerifier,
    private readonly revocations: SessionRevocationStore,
    private readonly permissions: PermissionResolver,
  ) {}

  /**
   * @throws AccessTokenExpired 401 `token_expired`
   * @throws Unauthenticated 401 `unauthorized` (invalid, foreign app, revoked session)
   * @throws RedisUnavailableError 503 `service_unavailable`
   */
  async authenticate(token: string, client: ClientContext): Promise<Principal> {
    const claims = await this.verifier.verify(token);

    if (claims.app !== client.app) {
      this.logger.warn(
        { tokenApp: claims.app, clientApp: client.app, sid: claims.sid },
        'Access token presented by another app',
      );
      throw new Unauthenticated();
    }
    if (await this.revocations.isRevoked(claims.sid)) {
      this.logger.debug({ sid: claims.sid }, 'Access token of a revoked session');
      throw new Unauthenticated();
    }

    return {
      userId: claims.sub,
      sessionId: claims.sid,
      app: claims.app,
      roles: claims.roles,
      permissions: this.permissions.effectivePermissions(claims.roles, claims.app),
      tokenId: claims.jti,
    };
  }
}
