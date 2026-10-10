import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../shared/errors';
import type { RateLimiter, RateLimitResult, RateLimitRule } from '../../../shared/redis';
import { decodeCouponCursor, encodeCouponCursor } from '../application/coupon-cursor';
import {
  CouponCodeTaken,
  CouponNotApplicable,
  InvalidCommerceField,
  PriceNotAllowed,
} from '../domain/commerce.errors';
import { mapCommerceConstraints, rethrowCommerceConstraint } from './commerce-constraint-errors';
import {
  COMMERCE_RATE_LIMITS,
  commerceRateLimitKeys,
  RedisCommerceRateLimiter,
} from './redis-commerce-rate-limiter';

/** In-memory fixed-window counters with the RateLimiter contract (`count > limit` = limited). */
class FakeRateLimiter {
  readonly counts = new Map<string, number>();
  readonly rules = new Map<string, RateLimitRule>();

  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    this.rules.set(key, rule);
    return Promise.resolve({ count, ttlMs: rule.windowMs / 2, limited: count > rule.limit });
  }
}

function limiter(): { fake: FakeRateLimiter; commerce: RedisCommerceRateLimiter } {
  const fake = new FakeRateLimiter();
  return { fake, commerce: new RedisCommerceRateLimiter(fake as unknown as RateLimiter) };
}

describe('RedisCommerceRateLimiter (design §9 rules)', () => {
  it('uses the documented keys and rules', async () => {
    const { fake, commerce } = limiter();
    await commerce.hitCartWrite('u1');
    await commerce.hitCouponApply('u1', '203.0.113.7');
    await commerce.hitPriceChange('c1');
    await commerce.hitCouponCreate('u1');
    await commerce.hitCheckout('u1');
    await commerce.hitRefundRequest('u1');
    expect(Object.fromEntries(fake.rules)).toEqual({
      'rl:commerce:cart:u:u1': { limit: 120, windowMs: 3_600_000 },
      'rl:commerce:coupon:u:u1': { limit: 20, windowMs: 3_600_000 },
      'rl:commerce:coupon:ip:203.0.113.7': { limit: 60, windowMs: 3_600_000 },
      'rl:commerce:price:c:c1': { limit: 10, windowMs: 86_400_000 },
      'rl:commerce:coupon-create:u:u1': { limit: 50, windowMs: 86_400_000 },
      'rl:commerce:checkout:u:u1': { limit: 10, windowMs: 600_000 },
      'rl:commerce:refund:u:u1': { limit: 5, windowMs: 86_400_000 },
    });
    expect(commerceRateLimitKeys.priceChange('c1')).toBe('rl:commerce:price:c:c1');
  });

  it('throws 429 once a window is exhausted, with a Retry-After of the window rest', async () => {
    const { commerce } = limiter();
    for (let i = 0; i < COMMERCE_RATE_LIMITS.priceChange.limit; i++)
      await commerce.hitPriceChange('c');
    const error = await commerce.hitPriceChange('c').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).code).toBe(ErrorCode.RateLimited);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(43_200);
  });

  it('coupon apply counts BOTH buckets on every attempt; either one limits', async () => {
    const { fake, commerce } = limiter();
    fake.counts.set(commerceRateLimitKeys.couponApplyIp('ip'), 60);
    await expect(commerce.hitCouponApply('fresh-user', 'ip')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fake.counts.get(commerceRateLimitKeys.couponApplyUser('fresh-user'))).toBe(1);

    fake.counts.set(commerceRateLimitKeys.couponApplyUser('busy'), 20);
    await expect(commerce.hitCouponApply('busy', 'other-ip')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fake.counts.get(commerceRateLimitKeys.couponApplyIp('other-ip'))).toBe(1);
  });
});

describe('coupon cursor', () => {
  it('round-trips a coupon id and rejects anything else (422)', () => {
    const id = '0190a000-0000-7000-8000-00000000000a';
    expect(decodeCouponCursor(encodeCouponCursor(id))).toBe(id);
    for (const bad of ['', 'x', Buffer.from('{"c":"nope"}').toString('base64url')]) {
      expect(() => decodeCouponCursor(bad), bad).toThrow('Invalid cursor.');
    }
  });
});

describe('commerce constraint map (schema doc §9)', () => {
  const pg = (constraint: string, code = '23505') =>
    Object.assign(new Error(constraint), { code, constraint });

  it('maps the context-free constraints to their domain errors', () => {
    const mapped = (constraint: string): unknown => {
      try {
        rethrowCommerceConstraint(pg(constraint));
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(mapped('coupons_course_id_code_uq')).toBeInstanceOf(CouponCodeTaken);
    expect(mapped('course_prices_amount_ck')).toBeInstanceOf(PriceNotAllowed);
    expect(mapped('coupons_window_ck')).toBeInstanceOf(InvalidCommerceField);
    const used = mapped('coupon_redemptions_coupon_id_user_id_active_uq');
    expect(used).toBeInstanceOf(CouponNotApplicable);
    expect((used as CouponNotApplicable).problem).toBe(ErrorCode.CouponAlreadyUsed);
    expect((mapped('refunds_order_line_id_live_uq') as { code: string }).code).toBe(
      ErrorCode.RefundAlreadyRequested,
    );
    expect((mapped('order_transitions_edge_ck') as { code: string }).code).toBe(
      ErrorCode.InvalidStateTransition,
    );
  });

  it('leaves programming errors (and non-pg errors) untouched, so they stay 500s', async () => {
    const deferred = pg('orders_total_ck', '23514');
    await expect(mapCommerceConstraints(() => Promise.reject(deferred))).rejects.toBe(deferred);
    const plain = new Error('boom');
    await expect(mapCommerceConstraints(() => Promise.reject(plain))).rejects.toBe(plain);
    await expect(mapCommerceConstraints(() => Promise.resolve(7))).resolves.toBe(7);
  });
});
