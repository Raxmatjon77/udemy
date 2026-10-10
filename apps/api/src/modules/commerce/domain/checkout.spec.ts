import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  cancelDecision,
  checkoutBlock,
  type IdempotentOrder,
  MIN_CHARGE_MINOR,
  orderIdCandidates,
  receivedDecimal,
  resumeDecision,
} from './checkout';
import { Money } from './money';
import type { Quote } from './quote';

const usd = (amount: string): Money => Money.fromDecimal(amount, 'USD');

function quote(options: { total: string; lines?: number; unavailable?: number }): Quote {
  const lineCount = options.lines ?? 1;
  return {
    currency: 'USD',
    lines: Array.from({ length: lineCount }, () => ({}) as Quote['lines'][number]),
    unavailable: Array.from(
      { length: options.unavailable ?? 0 },
      () => ({}) as Quote['unavailable'][number],
    ),
    coupon: null,
    totals: { list: usd(options.total), discount: usd('0.00'), total: usd(options.total) },
    itemCount: lineCount + (options.unavailable ?? 0),
    fingerprint: 'f'.repeat(64),
    divergences: [],
  };
}

describe('checkoutBlock (design §5 Checkout step 2.4, checks in order)', () => {
  it('cart_empty only when there is nothing at all', () => {
    expect(checkoutBlock(quote({ total: '0.00', lines: 0 }), usd('0.00'))).toBe(
      ErrorCode.CartEmpty,
    );
    expect(checkoutBlock(quote({ total: '0.00', lines: 0, unavailable: 1 }), usd('0.00'))).toBe(
      ErrorCode.CartChanged,
    );
  });

  it('cart_changed beats price_changed; price_changed beats amount_below_minimum', () => {
    expect(checkoutBlock(quote({ total: '19.99', unavailable: 1 }), usd('1.00'))).toBe(
      ErrorCode.CartChanged,
    );
    expect(checkoutBlock(quote({ total: '0.30' }), usd('0.31'))).toBe(ErrorCode.PriceChanged);
    expect(checkoutBlock(quote({ total: '0.30' }), usd('0.30'))).toBe(ErrorCode.AmountBelowMinimum);
  });

  it('accepts zero (D14) and the Stripe minimum exactly', () => {
    expect(checkoutBlock(quote({ total: '0.00' }), usd('0.00'))).toBeNull();
    expect(checkoutBlock(quote({ total: '0.49' }), usd('0.49'))).toBe(ErrorCode.AmountBelowMinimum);
    expect(MIN_CHARGE_MINOR).toBe(50);
    expect(checkoutBlock(quote({ total: '0.50' }), usd('0.50'))).toBeNull();
    expect(checkoutBlock(quote({ total: '19.99' }), usd('19.99'))).toBeNull();
  });
});

describe('resumeDecision (resume by Idempotency-Key, R7, schema doc §6 item 6)', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const order = (overrides: Partial<IdempotentOrder>): IdempotentOrder => ({
    orderId: 'o',
    status: 'PENDING_PAYMENT',
    total: usd('19.99'),
    paymentStatus: 'OPEN',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    sessionExpiresAt: new Date(now.getTime() + 35 * 60_000),
    ...overrides,
  });

  it('another expectedTotal under the same key is reused', () => {
    expect(resumeDecision(order({}), usd('20.00'), now, 30)).toEqual({ kind: 'reused' });
  });

  it('an OPEN session answers its url; other states answer without one', () => {
    expect(resumeDecision(order({}), usd('19.99'), now, 30)).toEqual({
      kind: 'answer',
      status: 'PENDING_PAYMENT',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(
      resumeDecision(order({ status: 'PAID', paymentStatus: 'SUCCEEDED' }), usd('19.99'), now, 30),
    ).toEqual({ kind: 'answer', status: 'PAID', checkoutUrl: null });
    expect(
      resumeDecision(
        order({ status: 'PAID', paymentStatus: null, sessionExpiresAt: null }),
        usd('19.99'),
        now,
        30,
      ),
    ).toEqual({ kind: 'answer', status: 'PAID', checkoutUrl: null });
    expect(
      resumeDecision(
        order({ status: 'CANCELED', paymentStatus: 'EXPIRED' }),
        usd('19.99'),
        now,
        30,
      ),
    ).toEqual({ kind: 'answer', status: 'CANCELED', checkoutUrl: null });
  });

  it('a CREATING payment is (re)created only while expires_at is still >= 30 min ahead', () => {
    const creating = (minutesLeft: number) =>
      order({
        paymentStatus: 'CREATING',
        checkoutUrl: null,
        sessionExpiresAt: new Date(now.getTime() + minutesLeft * 60_000),
      });
    expect(resumeDecision(creating(35), usd('19.99'), now, 30)).toEqual({ kind: 'create' });
    expect(resumeDecision(creating(30.01), usd('19.99'), now, 30)).toEqual({ kind: 'create' });
    expect(resumeDecision(creating(30), usd('19.99'), now, 30)).toEqual({ kind: 'abandon' });
    expect(resumeDecision(creating(5), usd('19.99'), now, 30)).toEqual({ kind: 'abandon' });
  });
});

describe('cancelDecision', () => {
  it.each([
    ['PENDING_PAYMENT', 'cancel'],
    ['EXPIRED', 'already_closed'],
    ['CANCELED', 'already_closed'],
    ['PAID', 'not_cancelable'],
    ['PAYMENT_REVIEW', 'not_cancelable'],
    ['PARTIALLY_REFUNDED', 'not_cancelable'],
    ['REFUNDED', 'not_cancelable'],
  ] as const)('%s -> %s', (status, decision) => {
    expect(cancelDecision(status)).toBe(decision);
  });
});

describe('orderIdCandidates / receivedDecimal', () => {
  const id = '01a1244b-642c-78d7-857a-31689e50a790';

  it('metadata first, then client_reference_id; non-UUIDs never reach SQL', () => {
    const other = '01a1244b-642c-78d7-857a-31689e50a791';
    expect(orderIdCandidates(id, other)).toEqual([id, other]);
    expect(orderIdCandidates(id.toUpperCase(), id)).toEqual([id]);
    expect(orderIdCandidates("x' OR 1=1 --", null)).toEqual([]);
    expect(orderIdCandidates(null, null)).toEqual([]);
  });

  it('minor units as a 2-decimal string, or null when it cannot be stored', () => {
    expect(receivedDecimal(0)).toBe('0.00');
    expect(receivedDecimal(5)).toBe('0.05');
    expect(receivedDecimal(1999)).toBe('19.99');
    expect(receivedDecimal(99_999_999_999)).toBe('999999999.99');
    expect(receivedDecimal(-1)).toBeNull();
    expect(receivedDecimal(1.5)).toBeNull();
    expect(receivedDecimal(100_000_000_000)).toBeNull();
  });
});
