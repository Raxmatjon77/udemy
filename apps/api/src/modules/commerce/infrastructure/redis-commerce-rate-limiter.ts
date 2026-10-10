import { Injectable } from '@nestjs/common';
import { COUPON_LIMITS, PRICE_CHANGES_PER_DAY } from '@udemy/contracts';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter, type RateLimitRule } from '../../../shared/redis';
import { CommerceRateLimiter } from '../application/ports/commerce-rate-limiter';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Design §9 rules (fixed windows starting at the first hit). */
export const COMMERCE_RATE_LIMITS = Object.freeze({
  cartWrite: { limit: 120, windowMs: HOUR_MS },
  couponApplyUser: { limit: 20, windowMs: HOUR_MS },
  couponApplyIp: { limit: 60, windowMs: HOUR_MS },
  priceChange: { limit: PRICE_CHANGES_PER_DAY, windowMs: DAY_MS },
  couponCreate: { limit: COUPON_LIMITS.creationsPerDay, windowMs: DAY_MS },
  checkout: { limit: 10, windowMs: 10 * MINUTE_MS },
  refundRequest: { limit: 5, windowMs: DAY_MS },
} satisfies Record<string, RateLimitRule>);

/** The Redis keys (exported for tests that reset or inspect a bucket). */
export const commerceRateLimitKeys = {
  cartWrite: (userId: string): string => `rl:commerce:cart:u:${userId}`,
  couponApplyUser: (userId: string): string => `rl:commerce:coupon:u:${userId}`,
  couponApplyIp: (ip: string): string => `rl:commerce:coupon:ip:${ip}`,
  priceChange: (courseId: string): string => `rl:commerce:price:c:${courseId}`,
  couponCreate: (userId: string): string => `rl:commerce:coupon-create:u:${userId}`,
  checkout: (userId: string): string => `rl:commerce:checkout:u:${userId}`,
  refundRequest: (userId: string): string => `rl:commerce:refund:u:${userId}`,
} as const;

/** Fixed-window Redis counters (`RateLimiter`, atomic Lua; fail-closed: Redis down is a 503). */
@Injectable()
export class RedisCommerceRateLimiter extends CommerceRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  hitCartWrite(userId: string): Promise<void> {
    return this.hit(
      commerceRateLimitKeys.cartWrite(userId),
      COMMERCE_RATE_LIMITS.cartWrite,
      'Too many cart changes. Please try again later.',
    );
  }

  async hitCouponApply(userId: string, ip: string): Promise<void> {
    const message = 'Too many coupon attempts. Please try again later.';
    // Both buckets count every attempt; the IP bucket stops one person cycling accounts.
    const [user, perIp] = await Promise.all([
      this.limiter.hit(
        commerceRateLimitKeys.couponApplyUser(userId),
        COMMERCE_RATE_LIMITS.couponApplyUser,
      ),
      this.limiter.hit(commerceRateLimitKeys.couponApplyIp(ip), COMMERCE_RATE_LIMITS.couponApplyIp),
    ]);
    const limited = [user, perIp].filter((r) => r.limited);
    if (limited.length > 0) {
      throw new RateLimitedError(message, {
        retryAfterMs: Math.max(...limited.map((r) => r.ttlMs)),
      });
    }
  }

  hitPriceChange(courseId: string): Promise<void> {
    return this.hit(
      commerceRateLimitKeys.priceChange(courseId),
      COMMERCE_RATE_LIMITS.priceChange,
      'Too many price changes for this course today. Please try again later.',
    );
  }

  hitCouponCreate(userId: string): Promise<void> {
    return this.hit(
      commerceRateLimitKeys.couponCreate(userId),
      COMMERCE_RATE_LIMITS.couponCreate,
      'Too many coupons created today. Please try again later.',
    );
  }

  hitCheckout(userId: string): Promise<void> {
    return this.hit(
      commerceRateLimitKeys.checkout(userId),
      COMMERCE_RATE_LIMITS.checkout,
      'Too many checkout attempts. Please try again later.',
    );
  }

  hitRefundRequest(userId: string): Promise<void> {
    return this.hit(
      commerceRateLimitKeys.refundRequest(userId),
      COMMERCE_RATE_LIMITS.refundRequest,
      'Too many refund requests. Please try again later.',
    );
  }

  private async hit(key: string, rule: RateLimitRule, message: string): Promise<void> {
    const result = await this.limiter.hit(key, rule);
    if (result.limited) throw new RateLimitedError(message, { retryAfterMs: result.ttlMs });
  }
}
