import { describe, expect, it } from 'vitest';
import {
  displayMoney,
  orderReceiptMail,
  paymentDisputedAlertMail,
  paymentMismatchAlertMail,
  refundFailedAlertMail,
  refundRejectedMail,
  refundReviewAlertMail,
  refundSucceededMail,
  refundUnderReviewMail,
} from './commerce-mail.templates';

const PAID_AT = new Date('2026-10-10T10:00:00.000Z');
const RECEIPT_URL = 'http://localhost:3000/account/orders/o-1/receipt';
const ORDER_URL = 'http://localhost:3000/account/orders/o-1';

const receipt = (overrides: Partial<Parameters<typeof orderReceiptMail>[0]> = {}) =>
  orderReceiptMail({
    displayName: 'Jane <Doe>',
    orderNumber: 1042,
    currency: 'USD',
    totalAmount: '59.98',
    paidAt: PAID_AT,
    free: false,
    lines: [
      {
        courseTitle: 'Rust <for>\nEveryone',
        listAmount: '49.99',
        discountAmount: '10.00',
        finalAmount: '39.99',
        couponCode: 'FALL<10>',
      },
      {
        courseTitle: 'Go & You',
        listAmount: '19.99',
        discountAmount: '0.00',
        finalAmount: '19.99',
        couponCode: null,
      },
    ],
    receiptUrl: RECEIPT_URL,
    ...overrides,
  });

describe('displayMoney', () => {
  it('formats allowlisted currencies from the decimal string, and falls back to "amount CODE"', () => {
    expect(displayMoney('19.99', 'USD')).toBe('$19.99');
    expect(displayMoney('1234.50', 'USD')).toBe('$1,234.50');
    expect(displayMoney('0.00', 'USD')).toBe('$0.00');
    expect(displayMoney('19.99', 'EUR')).toBe('19.99 EUR');
  });
});

describe('orderReceiptMail', () => {
  it('lists every line with its discount and coupon, the total and the receipt link', () => {
    const mail = receipt();
    expect(mail.subject).toBe('Your receipt for order #1042');
    expect(mail.text).toContain('Order #1042 was paid on 2026-10-10 10:00 UTC.');
    expect(mail.text).toContain(
      '"Rust <for> Everyone": $49.99 − $10.00 (coupon FALL<10>) = $39.99',
    );
    expect(mail.text).toContain('"Go & You": $19.99\n');
    expect(mail.text).toContain('Total: $59.98');
    expect(mail.text).toContain(`View your receipt: ${RECEIPT_URL}`);
    expect(mail.html).toContain(`href="${RECEIPT_URL}"`);
  });

  it('escapes titles and coupon codes in the HTML part and keeps titles on one line', () => {
    const mail = receipt();
    expect(mail.html).toContain('&quot;Rust &lt;for&gt; Everyone&quot;');
    expect(mail.html).toContain('coupon FALL&lt;10&gt;');
    expect(mail.html).toContain('&quot;Go &amp; You&quot;');
    expect(mail.html).not.toContain('<for>');
    expect(mail.text).not.toContain('<for>\nEveryone');
  });

  it('says nothing was charged for a zero-total order', () => {
    const mail = receipt({
      free: true,
      totalAmount: '0.00',
      lines: [
        {
          courseTitle: 'Free Rust',
          listAmount: '19.99',
          discountAmount: '19.99',
          finalAmount: '0.00',
          couponCode: null,
        },
      ],
    });
    expect(mail.text).toContain(
      'Order #1042 was completed on 2026-10-10 10:00 UTC; nothing was charged.',
    );
    expect(mail.text).toContain('"Free Rust": $19.99 − $19.99 (discount) = $0.00');
    expect(mail.text).toContain('Total: $0.00');
  });

  it('refuses a non-http(s) receipt link', () => {
    expect(() => receipt({ receiptUrl: 'javascript:alert(1)' })).toThrow(TypeError);
  });
});

describe('student refund mails', () => {
  it('succeeded: amount, title, order number and the order link', () => {
    const mail = refundSucceededMail({
      displayName: 'Jane',
      courseTitle: 'Rust <for> Everyone',
      orderNumber: '1042',
      amount: '39.99',
      currency: 'USD',
      succeededAt: PAID_AT,
      orderUrl: ORDER_URL,
    });
    expect(mail.subject).toBe('Your refund was processed');
    expect(mail.text).toContain(
      'We refunded $39.99 for "Rust <for> Everyone" (order #1042) on 2026-10-10 10:00 UTC.',
    );
    expect(mail.text).toContain(`View your order: ${ORDER_URL}`);
    expect(mail.html).toContain('&quot;Rust &lt;for&gt; Everyone&quot;');
  });

  it('succeeded: neutral wording when the commerce rows are gone', () => {
    const mail = refundSucceededMail({
      displayName: 'Jane',
      courseTitle: null,
      orderNumber: null,
      amount: '39.99',
      currency: 'USD',
      succeededAt: PAID_AT,
      orderUrl: ORDER_URL,
    });
    expect(mail.text).toContain('We refunded $39.99 for your course (your order)');
  });

  it("rejected: the escaped admin's reason; the student keeps access", () => {
    const mail = refundRejectedMail({
      displayName: 'Jane',
      courseTitle: 'Rust',
      orderNumber: '1042',
      reason: '  More than <b>half</b> of the course was watched & downloaded.  ',
      orderUrl: ORDER_URL,
    });
    expect(mail.subject).toBe('Your refund request was not approved');
    expect(mail.text).toContain(
      'Reason: More than <b>half</b> of the course was watched & downloaded.\n',
    );
    expect(mail.html).toContain('&lt;b&gt;half&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>half');
    expect(mail.text).toContain('You keep full access to the course.');
  });

  it('under review: amount, reason label and the order link', () => {
    const mail = refundUnderReviewMail({
      displayName: 'Jane',
      courseTitle: 'Rust',
      orderNumber: '1042',
      amount: '39.99',
      currency: 'USD',
      reasonCode: 'QUALITY',
      orderUrl: ORDER_URL,
    });
    expect(mail.subject).toBe('We received your refund request');
    expect(mail.text).toContain(
      'refund request of $39.99 for "Rust" (order #1042) needs a short review',
    );
    expect(mail.text).toContain('Reason given: Content or audio/video quality');
    expect(mail.text).toContain(`View your order: ${ORDER_URL}`);
  });
});

describe('admin alert mails', () => {
  const adminOrder = 'http://localhost:3002/orders/o-1';
  const queue = 'http://localhost:3002/refunds';

  it('payment mismatch: expected vs received, provider event, admin order link', () => {
    const mail = paymentMismatchAlertMail({
      adminName: 'Admin',
      orderNumber: '1042',
      expected: { amount: '59.98', currency: 'USD' },
      received: { amount: '5.99', currency: 'USD' },
      providerEventId: 'evt_<x>',
      detectedAt: PAID_AT,
      orderUrl: adminOrder,
    });
    expect(mail.subject).toBe('[Alert] Payment mismatch on order #1042');
    expect(mail.text).toContain('reported $5.99 for order #1042, but the order total is $59.98');
    expect(mail.text).toContain('Provider event: evt_<x>');
    expect(mail.html).toContain('Provider event: evt_&lt;x&gt;');
    expect(mail.text).toContain(`Open the order: ${adminOrder}`);
  });

  it('payment disputed: payment intent and the order link; "an order" when unknown', () => {
    const mail = paymentDisputedAlertMail({
      adminName: 'Admin',
      orderNumber: null,
      paymentIntentId: 'pi_123',
      openedAt: PAID_AT,
      orderUrl: adminOrder,
    });
    expect(mail.subject).toBe('[Alert] Payment disputed on an order');
    expect(mail.text).toContain(
      'A dispute (chargeback) was opened for an order on 2026-10-10 10:00 UTC.',
    );
    expect(mail.text).toContain('Payment intent: pi_123');
  });

  it('refund review and refund failed link to the refund queue', () => {
    const review = refundReviewAlertMail({
      adminName: 'Admin',
      courseTitle: 'Rust',
      orderNumber: '1042',
      amount: '39.99',
      currency: 'USD',
      reasonCode: 'OTHER',
      requestedAt: PAID_AT,
      queueUrl: queue,
    });
    expect(review.subject).toBe('[Review] Refund request on order #1042');
    expect(review.text).toContain(`Open the refund queue: ${queue}`);
    const failed = refundFailedAlertMail({
      adminName: 'Admin',
      courseTitle: 'Rust',
      orderNumber: '1042',
      failureCode: 'charge_already_refunded\r\nBcc: x@y',
      attempt: 2,
      failedAt: PAID_AT,
      queueUrl: queue,
    });
    expect(failed.subject).toBe('[Alert] Refund failed on order #1042');
    expect(failed.text).toContain('Failure code: charge_already_refunded Bcc: x@y\n');
    expect(failed.text).toContain('(attempt 2)');
  });
});
