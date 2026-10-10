import type { ClientApp, Role } from '@udemy/contracts';

export interface AccessTokenSubject {
  userId: string;
  sessionId: string;
  app: ClientApp;
  /** Every role held, including STUDENT. */
  roles: readonly Role[];
}

export interface IssuedAccessToken {
  /** Compact JWS. */
  token: string;
  /** `jti`. */
  tokenId: string;
  issuedAt: Date;
  /** `exp`; send it to the BFF as `accessTokenExpiresAt`. */
  expiresAt: Date;
  /** Key that signed it. */
  kid: string;
}

/** Mints access tokens (design §9 "JWT") with the active signing key. */
export abstract class AccessTokenIssuer {
  abstract issue(subject: AccessTokenSubject): Promise<IssuedAccessToken>;
}
