import { describe, expect, it } from 'vitest';
import { stripeForm } from '../testing/form-encode';
import { canonicalForm, parseForm, parseKey } from './form';
import { StripeApiError } from './stripe-error';

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('parseKey', () => {
  it('splits bracketed keys', () => {
    expect(parseKey('line_items[0][price_data][currency]')).toEqual([
      'line_items',
      '0',
      'price_data',
      'currency',
    ]);
    expect(parseKey('mode')).toEqual(['mode']);
    expect(parseKey('a[]')).toEqual(['a', '']);
  });

  it.each(['[a]', 'a[b', 'a]b[', 'a[b]c', ''])('rejects %j', (key) => {
    expect(() => parseKey(key)).toThrow(StripeApiError);
  });
});

describe('parseForm', () => {
  it('decodes the encoding stripe-node produces', () => {
    const encoded = stripeForm({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      metadata: { orderId: 'o 1&2' },
      line_items: [{ quantity: 1, price_data: { unit_amount: 1999 } }],
    });
    expect(plain(parseForm(encoded))).toEqual({
      mode: 'payment',
      allowed_payment_method_types: { '0': 'card' },
      metadata: { orderId: 'o 1&2' },
      line_items: { '0': { quantity: '1', price_data: { unit_amount: '1999' } } },
    });
  });

  it('accepts unencoded and encoded brackets, and `a[]` appends', () => {
    expect(plain(parseForm('a%5B0%5D=x&a[1]=y&b[]=1&b[]=2'))).toEqual({
      a: { '0': 'x', '1': 'y' },
      b: { '0': '1', '1': '2' },
    });
  });

  it('produces null-prototype objects (no prototype pollution)', () => {
    const parsed = parseForm('__proto__[polluted]=1&constructor[x]=1');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it('rejects a repeated key and a key that is both a value and a hash', () => {
    expect(() => parseForm('a=1&a=2')).toThrow(/more than once/);
    expect(() => parseForm('a=1&a[b]=2')).toThrow(/mixes a value and a hash/);
  });
});

describe('canonicalForm', () => {
  it('ignores parameter order', () => {
    expect(canonicalForm(parseForm('b=2&a[y]=1&a[x]=0'))).toBe(
      canonicalForm(parseForm('a[x]=0&a[y]=1&b=2')),
    );
    expect(canonicalForm(parseForm('a=1'))).not.toBe(canonicalForm(parseForm('a=2')));
  });
});
