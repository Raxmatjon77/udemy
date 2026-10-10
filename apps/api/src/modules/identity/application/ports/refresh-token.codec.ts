/** A freshly generated refresh token: give `token` to the BFF, store only `hash`. */
export interface GeneratedRefreshToken {
  /** 32 random bytes, base64url (43 characters). */
  readonly token: string;
  /** HMAC-SHA256(REFRESH_TOKEN_PEPPER, token): 32 bytes. */
  readonly hash: Buffer;
}

/** Opaque refresh tokens (design D3). */
export abstract class RefreshTokenCodec {
  abstract generate(): GeneratedRefreshToken;

  /** Hash of a presented token for the lookup; any string is accepted (garbage just misses). */
  abstract hash(token: string): Buffer;
}
