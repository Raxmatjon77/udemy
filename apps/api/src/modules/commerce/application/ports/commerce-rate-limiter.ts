/**
 * Commerce rate limits (design §9, Redis fixed windows, fail-closed: Redis down is a 503).
 * Each `hit*` counts one hit and throws `RateLimitedError` (429 `rate_limited`, Retry-After)
 * once the window is exhausted.
 *
 * | method             | key                                   | rule          |
 * | ------------------ | ------------------------------------- | ------------- |
 * | hitCartWrite       | `rl:commerce:cart:u:{uid}`            | 120 / 1 h     |
 * | hitCouponApply     | `rl:commerce:coupon:u:{uid}` + `:ip:` | 20 / 60 per h |
 * | hitPriceChange     | `rl:commerce:price:c:{courseId}`      | 10 / 24 h     |
 * | hitCouponCreate    | `rl:commerce:coupon-create:u:{uid}`   | 50 / 24 h     |
 * | hitCheckout        | `rl:commerce:checkout:u:{uid}`        | 10 / 10 min   |
 * | hitRefundRequest   | `rl:commerce:refund:u:{uid}`          | 5 / 24 h      |
 *
 * `hitCheckout` and `hitRefundRequest` are the P4-T15/T16 seams (free enrolment is limited by
 * the enrollment module).
 */
export abstract class CommerceRateLimiter {
  abstract hitCartWrite(userId: string): Promise<void>;
  /** Every apply counts, valid or not (brute force, §9); both the user and the IP bucket. */
  abstract hitCouponApply(userId: string, ip: string): Promise<void>;
  abstract hitPriceChange(courseId: string): Promise<void>;
  abstract hitCouponCreate(userId: string): Promise<void>;
  abstract hitCheckout(userId: string): Promise<void>;
  abstract hitRefundRequest(userId: string): Promise<void>;
}
