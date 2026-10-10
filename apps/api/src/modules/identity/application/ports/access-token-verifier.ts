import type { AccessTokenClaims } from '../../domain/access-token';

/**
 * Verifies access tokens with the LOCAL keys only (no JWKS fetch), `iss`, `aud`, EdDSA only
 * and a 30 s clock tolerance (design §9).
 */
export abstract class AccessTokenVerifier {
  /**
   * @throws AccessTokenExpired (401 `token_expired`) for an otherwise valid but expired token
   * @throws Unauthenticated (401 `unauthorized`) for every other failure
   */
  abstract verify(token: string): Promise<AccessTokenClaims>;
}
