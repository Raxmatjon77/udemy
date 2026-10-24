import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config';
import { UnsubscribeTokenCodec } from '../application/ports/unsubscribe-token.codec';
import {
  formatUnsubscribeToken,
  parseUnsubscribeToken,
  type UnsubscribeTokenClaims,
  unsubscribeMacInput,
} from '../domain/unsubscribe-token';

/**
 * HMAC-SHA256 with `NOTIFICATIONS_UNSUBSCRIBE_SECRET` (the worker signs with the same secret,
 * design §14 configuration). The presented MAC is compared with `timingSafeEqual` over the raw
 * 32 bytes, after a canonical-encoding check that depends on the input only (not the secret).
 */
@Injectable()
export class HmacUnsubscribeTokenCodec extends UnsubscribeTokenCodec {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    super();
    this.key = Buffer.from(config.get('NOTIFICATIONS_UNSUBSCRIBE_SECRET'), 'utf8');
  }

  sign(claims: UnsubscribeTokenClaims): string {
    const token = formatUnsubscribeToken(claims, this.mac(claims).toString('base64url'));
    if (parseUnsubscribeToken(token) === null) {
      throw new TypeError('Cannot sign an unsubscribe token for these claims');
    }
    return token;
  }

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
