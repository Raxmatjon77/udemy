import type { UnsubscribeTokenClaims } from '../../domain/unsubscribe-token';

/**
 * Signs and verifies the one-click unsubscribe tokens (`domain/unsubscribe-token.ts`). The
 * verification compares MACs in constant time; neither method logs the token.
 */
export abstract class UnsubscribeTokenCodec {
  abstract sign(claims: UnsubscribeTokenClaims): string;

  /** The claims of a genuine token; null for anything malformed, forged or locked. */
  abstract verify(token: string): UnsubscribeTokenClaims | null;
}
