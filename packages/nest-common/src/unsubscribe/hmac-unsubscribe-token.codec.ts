import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  formatUnsubscribeToken,
  parseUnsubscribeToken,
  type UnsubscribeTokenClaims,
  unsubscribeMacInput,
} from './unsubscribe-token';

/** Same lower bound as the env schemas of the api and the worker. */
const MIN_SECRET_LENGTH = 32;

/**
 * The reference codec of the one-click unsubscribe tokens (`unsubscribe-token.ts`): HMAC-SHA256
 * with `NOTIFICATIONS_UNSUBSCRIBE_SECRET`. The worker signs, the api verifies; both construct
 * this class from their validated env, so the signature cannot drift between them.
 *
 * The presented MAC is compared with `timingSafeEqual` over the raw 32 bytes, after a
 * canonical-encoding check that depends on the input only (not the secret). Neither method logs
 * the token. Plain class (no Nest decorator): each app binds it with a factory provider.
 */
export class HmacUnsubscribeTokenCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new TypeError(
        `The unsubscribe secret must have at least ${MIN_SECRET_LENGTH} characters`,
      );
    }
    this.key = Buffer.from(secret, 'utf8');
  }

  /** Throws TypeError for claims no valid token can carry (bad user id, locked category). */
  sign(claims: UnsubscribeTokenClaims): string {
    const token = formatUnsubscribeToken(claims, this.mac(claims).toString('base64url'));
    if (parseUnsubscribeToken(token) === null) {
      throw new TypeError('Cannot sign an unsubscribe token for these claims');
    }
    return token;
  }

  /** The claims of a genuine token; null for anything malformed, forged or locked. */
  verify(token: string): UnsubscribeTokenClaims | null {
    const parsed = parseUnsubscribeToken(token);
    if (parsed === null) return null;
    const presented = Buffer.from(parsed.mac, 'base64url');
    // Exactly one encoding per MAC (base64url decoding ignores the last character's spare bits).
    if (presented.toString('base64url') !== parsed.mac) return null;
    const expected = this.mac(parsed.claims);
    if (presented.length !== expected.length) return null;
    return timingSafeEqual(presented, expected) ? parsed.claims : null;
  }

  private mac(claims: UnsubscribeTokenClaims): Buffer {
    return createHmac('sha256', this.key).update(unsubscribeMacInput(claims), 'utf8').digest();
  }
}
