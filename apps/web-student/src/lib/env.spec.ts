import { describe, expect, it } from 'vitest';

import { CheckoutAllowedOriginsSchema, RealtimePublicUrlSchema } from './env';

describe('CHECKOUT_ALLOWED_ORIGINS', () => {
  it('parses a comma-separated list of origins', () => {
    expect(
      CheckoutAllowedOriginsSchema.parse('https://checkout.stripe.com, http://127.0.0.1:12111'),
    ).toEqual(['https://checkout.stripe.com', 'http://127.0.0.1:12111']);
  });

  it.each([
    [undefined, 'required'],
    ['', 'at least one'],
    ['https://checkout.stripe.com/', 'scheme://host'],
    ['https://checkout.stripe.com/c/pay', 'scheme://host'],
    ['ftp://checkout.stripe.com', ''],
    ['checkout.stripe.com', ''],
  ])('refuses %j', (value, message) => {
    const result = CheckoutAllowedOriginsSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });
});

describe('REALTIME_PUBLIC_URL', () => {
  it.each([
    ['http://localhost:4000', 'http://localhost:4000'],
    ['https://api.udemy.example', 'https://api.udemy.example'],
    [undefined, undefined],
    ['', undefined],
  ])('accepts %j', (value, expected) => {
    expect(RealtimePublicUrlSchema.parse(value)).toBe(expected);
  });

  it.each([
    'http://localhost:4000/',
    'http://localhost:4000/realtime/socket.io',
    'ws://localhost:4000',
    'localhost:4000',
  ])('refuses %j', (value) => {
    expect(RealtimePublicUrlSchema.safeParse(value).success).toBe(false);
  });
});
