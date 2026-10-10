import { describe, expect, it } from 'vitest';

import { CheckoutAllowedOriginsSchema } from './env';

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
