/** @vitest-environment jsdom */
import { CART_LIMITS } from '@udemy/contracts';
import { fixtureId } from '@udemy/contracts/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHECKOUT_ATTEMPT_KEY, checkoutAttemptKey, clearCheckoutAttempt } from './checkout-attempt';
import { isAllowedCheckoutUrl, redirectToCheckout } from './checkout-redirect';
import { addToGuestCart, clearGuestCart, readGuestCart } from './guest-cart';
import { orderIdFromSearch } from './search-params';

const assignLocation = vi.fn();
vi.mock('./navigation', () => ({ assignLocation: (url: string) => assignLocation(url) }));

beforeEach(() => {
  assignLocation.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('isAllowedCheckoutUrl', () => {
  const allowed = ['https://checkout.stripe.com', 'http://127.0.0.1:12111'];

  it.each([
    'https://checkout.stripe.com/c/pay/cs_test_a1#fid',
    'http://127.0.0.1:12111/pay/cs_test_1',
  ])('accepts %s', (url) => expect(isAllowedCheckoutUrl(url, allowed)).toBe(true));

  it.each([
    'https://checkout.stripe.com.evil.example/c/pay',
    'https://evil.example/https://checkout.stripe.com',
    'http://checkout.stripe.com/c/pay',
    'https://checkout.stripe.com:8443/c/pay',
    'http://127.0.0.1:12112/pay/cs_test_1',
    'https://user:pass@checkout.stripe.com/c/pay',
    'javascript:alert(1)',
    '/relative/path',
    'not a url',
  ])('refuses %s', (url) => expect(isAllowedCheckoutUrl(url, allowed)).toBe(false));

  it('navigates only to an allowed origin', () => {
    expect(redirectToCheckout('https://evil.example/pay', allowed)).toBe(false);
    expect(assignLocation).not.toHaveBeenCalled();
    expect(redirectToCheckout('https://checkout.stripe.com/c/pay/x', allowed)).toBe(true);
    expect(assignLocation).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/x');
  });
});

describe('checkoutAttemptKey', () => {
  it('reuses the key for the same cart and makes a new one for another cart', () => {
    const first = checkoutAttemptKey('a'.repeat(64));
    expect(checkoutAttemptKey('a'.repeat(64))).toBe(first);
    const other = checkoutAttemptKey('b'.repeat(64));
    expect(other).not.toBe(first);
    expect(other).toMatch(/^[0-9a-f-]{36}$/);
    clearCheckoutAttempt();
    expect(window.sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
    expect(checkoutAttemptKey('b'.repeat(64))).not.toBe(other);
  });

  it('ignores a tampered stored attempt', () => {
    window.sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY, '{"key":"x","fingerprint":"f"}');
    expect(checkoutAttemptKey('f')).not.toBe('x');
  });
});

describe('guest cart storage', () => {
  it('keeps unique course ids, at most the cart limit', () => {
    expect(addToGuestCart(fixtureId(1))).toBe('added');
    expect(addToGuestCart(fixtureId(1))).toBe('present');
    for (let i = 2; i <= CART_LIMITS.maxItems; i += 1) addToGuestCart(fixtureId(i));
    expect(readGuestCart()).toHaveLength(CART_LIMITS.maxItems);
    expect(addToGuestCart(fixtureId(99))).toBe('full');
    expect(JSON.parse(window.localStorage.getItem('udemy.guest-cart.v1')!)).toHaveLength(
      CART_LIMITS.maxItems,
    );
    clearGuestCart();
    expect(readGuestCart()).toEqual([]);
  });
});

describe('orderIdFromSearch', () => {
  const id = fixtureId(7);
  it('reads ?orderId= (and ?order=), ignoring anything that is not a UUID', () => {
    expect(orderIdFromSearch({ orderId: id })).toBe(id);
    expect(orderIdFromSearch({ order: id })).toBe(id);
    expect(orderIdFromSearch({ orderId: [id, 'x'] })).toBe(id);
    expect(orderIdFromSearch({ orderId: '../admin' })).toBeNull();
    expect(orderIdFromSearch({})).toBeNull();
  });
});
