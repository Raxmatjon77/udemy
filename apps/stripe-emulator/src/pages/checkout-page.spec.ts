import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../stripe/emulator';
import { escapeHtml, formatMoney, renderCheckoutPage } from './checkout-page';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'cs_test_1',
    created: 1_800_000_000,
    expiresAt: 1_800_001_800,
    status: 'open',
    paymentStatus: 'unpaid',
    currency: 'usd',
    amountTotal: 3998,
    lineItems: [
      { name: 'Course A', unitAmount: 1999, quantity: 1, amountTotal: 1999 },
      { name: 'Course B', unitAmount: 1999, quantity: 1, amountTotal: 1999 },
    ],
    clientReferenceId: 'ord_1',
    customerEmail: null,
    metadata: {},
    paymentIntentMetadata: {},
    successUrl: 'http://127.0.0.1:3000/ok',
    cancelUrl: null,
    paymentIntentId: null,
    lastDeclineMessage: null,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('formatMoney', () => {
  it('formats minor units per currency', () => {
    expect(formatMoney(21998, 'usd')).toBe('$219.98');
    expect(formatMoney(0, 'usd')).toBe('$0.00');
    expect(formatMoney(500, 'jpy')).toBe('¥500');
  });
});

describe('renderCheckoutPage', () => {
  it('omits Cancel without a cancel_url and links the error with aria-describedby', () => {
    const html = renderCheckoutPage(session({ lastDeclineMessage: 'Declined.' }), {
      action: '/pay/cs_test_1',
    });
    expect(html).not.toContain('value="cancel"');
    expect(html).toContain('aria-describedby="payment-error"');
    expect(html).toContain('<div class="alert" role="alert" id="payment-error">Declined.</div>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('$39.98');
  });
});
