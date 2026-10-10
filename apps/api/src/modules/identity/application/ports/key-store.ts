import type { Ed25519Jwk } from '@udemy/contracts';

/**
 * The application's view of the JWT signing keys: which key signs, and which public keys are
 * published. The private halves stay inside infrastructure.
 */
export abstract class KeyStore {
  /** kid of the signing key (`JWT_ACTIVE_KID`). */
  abstract get activeKid(): string;

  /** Public JWKs of every loaded key, the active key first. */
  abstract publicJwks(): readonly Ed25519Jwk[];
}
