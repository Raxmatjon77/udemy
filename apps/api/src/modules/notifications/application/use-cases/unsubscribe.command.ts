import { Injectable } from '@nestjs/common';
import { NOTIFICATION_RATE_LIMITS } from '@udemy/contracts';
import { RateLimitedError } from '../../../../shared/errors/rate-limited.error';
import { RateLimiter } from '../../../../shared/redis';
import { InvalidUnsubscribeToken } from '../../domain/notifications.errors';
import { NotificationPreferenceRepository } from '../ports/notification-preference.repository';
import { UnsubscribeTokenCodec } from '../ports/unsubscribe-token.codec';

/** `rl:ntf:unsub:ip:{ip}` (design §6 "Redis keys", §9: 30 per hour per IP). */
export function unsubscribeRateLimitKey(ip: string): string {
  return `rl:ntf:unsub:ip:${ip}`;
}

export interface UnsubscribeInput {
  /** The token from the e-mail (never logged). */
  readonly token: string;
  /** The end user's IP as the BFF reported it (rate limit). */
  readonly ip: string;
}

/**
 * `Unsubscribe` (design §5, D14; RFC 8058 one-click): no session. Counts the attempt per IP
 * first (forgeries count too), verifies `HMAC(secret, v1|userId|category)` in constant time,
 * then stores EMAIL = false for that one category. Idempotent: a repeat, or a token of a
 * deleted account, answers success without a change.
 *
 * Errors: 400 `invalid_unsubscribe_token`, 429 `rate_limited`, 503 (Redis down, fail closed).
 */
@Injectable()
export class UnsubscribeCommand {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly tokens: UnsubscribeTokenCodec,
    private readonly preferences: NotificationPreferenceRepository,
  ) {}

  async execute(input: UnsubscribeInput): Promise<void> {
    const rule = NOTIFICATION_RATE_LIMITS.unsubscribe;
    const limit = await this.limiter.hit(unsubscribeRateLimitKey(input.ip), {
      limit: rule.limit,
      windowMs: rule.windowSeconds * 1000,
    });
    if (limit.limited) {
      throw new RateLimitedError('Too many requests. Please retry later.', {
        retryAfterMs: limit.ttlMs,
      });
    }
    const claims = this.tokens.verify(input.token);
    if (claims === null) throw new InvalidUnsubscribeToken();
    await this.preferences.upsert(claims.userId, [
      { category: claims.category, channel: 'EMAIL', enabled: false },
    ]);
  }
}
