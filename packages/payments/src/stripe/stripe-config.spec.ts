import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { PaymentConfigError } from '../errors';
import {
  parseStripeApiBaseUrl,
  STRIPE_API_VERSION,
  stripeProviderConfigFromEnv,
  stripeWebhookConfigFromEnv,
  validateStripeProviderConfig,
} from './stripe-config';

describe('stripe config', () => {
  it('pins the API version of the exact SDK dependency', () => {
    expect(Stripe.API_VERSION).toBe(STRIPE_API_VERSION);
    expect(Stripe.PACKAGE_VERSION).toBe('23.0.0');
  });

  it('parses STRIPE_API_BASE_URL into host/port/protocol', () => {
    expect(parseStripeApiBaseUrl('http://127.0.0.1:12111')).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 12111,
    });
    expect(parseStripeApiBaseUrl('https://stripe-emulator.test/')).toEqual({
      protocol: 'https',
      host: 'stripe-emulator.test',
      port: 443,
    });
    expect(parseStripeApiBaseUrl('http://[::1]:8080')).toEqual({
      protocol: 'http',
      host: '::1',
      port: 8080,
    });
    for (const bad of ['nope', 'ftp://x', 'http://x/v1', 'http://x?a=1', 'http://u:p@x']) {
      expect(() => parseStripeApiBaseUrl(bad)).toThrow(PaymentConfigError);
    }
  });

  it('accepts test keys and refuses live keys unless explicitly allowed', () => {
    expect(validateStripeProviderConfig({ secretKey: ' sk_test_abc ' }).secretKey).toBe(
      'sk_test_abc',
    );
    expect(() => validateStripeProviderConfig({ secretKey: 'rk_test_abc' })).not.toThrow();
    expect(() => validateStripeProviderConfig({ secretKey: 'sk_live_abc' })).toThrow(
      /test-mode only/,
    );
    expect(() => validateStripeProviderConfig({ secretKey: 'rk_live_abc' })).toThrow(
      PaymentConfigError,
    );
    expect(() => validateStripeProviderConfig({ secretKey: 'pk_test_abc' })).toThrow(
      PaymentConfigError,
    );
    expect(() =>
      validateStripeProviderConfig({ secretKey: 'sk_live_abc', allowLiveKeys: true }),
    ).not.toThrow();
  });

  it('reads STRIPE_* env and enforces the pinned STRIPE_API_VERSION', () => {
    expect(
      stripeProviderConfigFromEnv({
        STRIPE_SECRET_KEY: 'sk_test_emulator_dev',
        STRIPE_API_BASE_URL: 'http://127.0.0.1:12111',
        STRIPE_API_VERSION,
      }),
    ).toEqual({ secretKey: 'sk_test_emulator_dev', apiBaseUrl: 'http://127.0.0.1:12111' });
    expect(
      stripeProviderConfigFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE_URL: '' }),
    ).toEqual({ secretKey: 'sk_test_x' });
    expect(() =>
      stripeProviderConfigFromEnv({
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_API_VERSION: '2024-06-20',
      }),
    ).toThrow(/pinned/);
    expect(() => stripeProviderConfigFromEnv({})).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('reads the webhook secret and tolerance', () => {
    expect(stripeWebhookConfigFromEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_dev_emulator_x' })).toEqual({
      secret: 'whsec_dev_emulator_x',
      toleranceSeconds: 300,
    });
    expect(
      stripeWebhookConfigFromEnv({
        STRIPE_WEBHOOK_SECRET: 'whsec_dev_emulator_x',
        STRIPE_WEBHOOK_TOLERANCE_S: '120',
      }).toleranceSeconds,
    ).toBe(120);
    for (const env of [
      { STRIPE_WEBHOOK_SECRET: 'sk_test_x' },
      { STRIPE_WEBHOOK_SECRET: 'whsec_dev_emulator_x', STRIPE_WEBHOOK_TOLERANCE_S: '0' },
      { STRIPE_WEBHOOK_SECRET: 'whsec_dev_emulator_x', STRIPE_WEBHOOK_TOLERANCE_S: 'abc' },
    ]) {
      expect(() => stripeWebhookConfigFromEnv(env)).toThrow(PaymentConfigError);
    }
  });
});
