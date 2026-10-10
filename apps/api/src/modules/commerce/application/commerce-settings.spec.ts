import { describe, expect, it } from 'vitest';
import { type CommerceEnv, CommerceSettings, STRIPE_CHECKOUT_ORIGIN } from './commerce-settings';

const env: CommerceEnv = {
  COMMERCE_CURRENCY: 'USD',
  COMMERCE_CART_MAX_ITEMS: 20,
  COMMERCE_INSTRUCTOR_SHARE_BPS: 7000,
  COMMERCE_CHECKOUT_SESSION_TTL_MIN: 35,
  COMMERCE_REFUND_WINDOW_DAYS: 30,
  COMMERCE_JOBS_ENABLED: true,
  COMMERCE_RECONCILE_INTERVAL_MS: 300_000,
  COMMERCE_REFUND_DISPATCH_INTERVAL_MS: 60_000,
  STUDENT_APP_ORIGIN: 'https://learn.example.com',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_0000000000',
  STRIPE_WEBHOOK_TOLERANCE_S: 300,
};

describe('CommerceSettings', () => {
  it('builds the success/cancel urls from STUDENT_APP_ORIGIN', () => {
    const settings = CommerceSettings.fromEnv(env);
    expect(settings.checkoutSuccessUrl('o-1')).toBe(
      'https://learn.example.com/checkout/success?orderId=o-1',
    );
    expect(settings.checkoutCancelUrl('o-1')).toBe(
      'https://learn.example.com/checkout/cancel?orderId=o-1',
    );
  });

  it('allowed checkout origins: explicit list, else the STRIPE_API_BASE_URL origin, else Stripe', () => {
    expect(CommerceSettings.fromEnv(env).allowedCheckoutOrigins).toEqual([STRIPE_CHECKOUT_ORIGIN]);
    expect(
      CommerceSettings.fromEnv({ ...env, STRIPE_API_BASE_URL: 'http://127.0.0.1:12111' })
        .allowedCheckoutOrigins,
    ).toEqual(['http://127.0.0.1:12111']);
    expect(
      CommerceSettings.fromEnv({
        ...env,
        STRIPE_API_BASE_URL: 'http://127.0.0.1:12111',
        CHECKOUT_ALLOWED_ORIGINS: ['https://pay.example.com/'],
      }).allowedCheckoutOrigins,
    ).toEqual(['https://pay.example.com']);
  });

  it('isAllowedCheckoutUrl compares origins exactly', () => {
    const settings = CommerceSettings.fromEnv(env);
    expect(settings.isAllowedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_1')).toBe(true);
    expect(settings.isAllowedCheckoutUrl('https://checkout.stripe.com.evil.example/c/pay')).toBe(
      false,
    );
    expect(settings.isAllowedCheckoutUrl('http://checkout.stripe.com/c/pay')).toBe(false);
    expect(settings.isAllowedCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(settings.isAllowedCheckoutUrl('not a url')).toBe(false);
  });

  it('refuses a session TTL below 35 minutes and other invalid values', () => {
    expect(() =>
      CommerceSettings.fromEnv({ ...env, COMMERCE_CHECKOUT_SESSION_TTL_MIN: 30 }),
    ).toThrow(RangeError);
    expect(() => CommerceSettings.defaults({ instructorShareBps: 10_001 })).toThrow(RangeError);
    expect(() => CommerceSettings.defaults({ cartMaxItems: 21 })).toThrow(RangeError);
    expect(() => CommerceSettings.defaults({ allowedCheckoutOrigins: [] })).toThrow(RangeError);
  });
});
