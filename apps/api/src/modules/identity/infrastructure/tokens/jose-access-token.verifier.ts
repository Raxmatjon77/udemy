import { Injectable, Logger } from '@nestjs/common';
import { ClientAppSchema, RoleSchema } from '@udemy/contracts';
import { errors, type JWTHeaderParameters, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppConfigService } from '../../../../shared/config';
import { AccessTokenVerifier } from '../../application/ports/access-token-verifier';
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
  type AccessTokenClaims,
} from '../../domain/access-token';
import { AccessTokenExpired, Unauthenticated } from '../../domain/identity.errors';
import { FileKeyStore, type JoseKey } from '../keys/file-key.store';

/** Shape check after jose verified signature, iss, aud and the time claims. */
const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.uuid(),
  sid: z.uuid(),
  app: ClientAppSchema,
  roles: z.array(RoleSchema).min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid(),
});

/** Compact JWS: three base64url segments. Anything bigger than this is not ours. */
const MAX_TOKEN_LENGTH = 4096;

@Injectable()
export class JoseAccessTokenVerifier extends AccessTokenVerifier {
  private readonly logger = new Logger(JoseAccessTokenVerifier.name);

  constructor(
    private readonly keys: FileKeyStore,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new Unauthenticated();
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, (header) => this.keyFor(header), {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.config.get('API_PUBLIC_URL'),
        audience: this.config.get('JWT_AUDIENCE'),
        clockTolerance: ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iss', 'aud', 'sub', 'sid', 'app', 'roles', 'iat', 'exp', 'jti'],
      }));
    } catch (error) {
      // jose checks the signature before any claim, and iss/aud before exp: only a genuine
      // token of ours whose only problem is its age reaches JWTExpired.
      if (error instanceof errors.JWTExpired) throw new AccessTokenExpired();
      this.logger.debug({ reason: describe(error) }, 'Access token rejected');
      throw new Unauthenticated({ cause: error });
    }

    const claims = ClaimsSchema.safeParse(payload);
    if (!claims.success) {
      this.logger.warn('Signed access token with unexpected claims');
      throw new Unauthenticated();
    }
    return claims.data;
  }

  private keyFor(header: JWTHeaderParameters): JoseKey {
    const key = header.kid === undefined ? undefined : this.keys.verificationKey(header.kid);
    if (key === undefined) throw new Unauthenticated();
    return key;
  }
}

function describe(error: unknown): string {
  if (error instanceof errors.JOSEError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}
