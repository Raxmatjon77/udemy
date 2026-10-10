import type { EventEnvelope } from '@udemy/contracts';
import { DependencyUnavailableError } from '@udemy/nest-common';
import type { MailMessage, MailSendResult } from '@udemy/nest-common/mail';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import {
  type AdminRecipient,
  AdminRecipientsReader,
} from '../../shared/mail/admin-recipients.reader';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { CommerceLinks } from '../mail/commerce-links';
import { CommerceMailReader, type RefundMailContext } from '../persistence/commerce-mail.reader';
import {
  AdminAlertSender,
  PaymentDisputedAlertHandler,
  PaymentMismatchAlertHandler,
  RefundFailedAlertHandler,
  RefundReviewAlertHandler,
} from './admin-alert-mailer.handlers';
import { ReceiptMailerHandler } from './receipt-mailer.handler';
import {
  RefundRejectedMailerHandler,
  RefundSucceededMailerHandler,
  RefundUnderReviewMailerHandler,
} from './refund-mailers.handlers';

const ORDER = '0199c8a0-0000-7000-8000-0000000000b1';
const LINE = '0199c8a0-0000-7000-8000-0000000000b2';
const REFUND = '0199c8a0-0000-7000-8000-0000000000b3';
const COURSE = '0199c8a0-0000-7000-8000-0000000000c1';
const BUYER = '0199c8a0-0000-7000-8000-000000000001';
const INSTRUCTOR = '0199c8a0-0000-7000-8000-000000000002';
const ADMIN_A = '0199c8a0-0000-7000-8000-00000000000a';
const ADMIN_B = '0199c8a0-0000-7000-8000-00000000000b';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = '2026-10-10T10:00:00.000Z';

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'commerce.order',
    aggregateId: ORDER,
    occurredAt: NOW,
    version,
    payload,
  };
}

const orderPaid = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'OrderPaid',
    {
      orderId: ORDER,
      orderNumber: 1042,
      userId: BUYER,
      currency: 'USD',
      totalAmount: '39.99',
      provider: 'STRIPE',
      paidAt: NOW,
      lines: [
        {
          orderLineId: LINE,
          courseId: COURSE,
          instructorId: INSTRUCTOR,
          courseTitle: 'Rust <for> Everyone',
          listAmount: '49.99',
          discountAmount: '10.00',
          finalAmount: '39.99',
          couponId: null,
          couponCode: null,
          revenueShareBps: 7000,
          instructorShareAmount: '27.99',
          platformShareAmount: '12.00',
        },
      ],
      ...overrides,
    },
    version,
  );

const refundSucceeded = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('RefundSucceeded', {
    refundId: REFUND,
    orderId: ORDER,
    orderLineId: LINE,
    userId: BUYER,
    courseId: COURSE,
    instructorId: INSTRUCTOR,
    currency: 'USD',
    amount: '39.99',
    instructorShareAmount: '27.99',
    platformShareAmount: '12.00',
    succeededAt: NOW,
    ...overrides,
  });

const refundRejected = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('RefundRejected', {
    refundId: REFUND,
    orderId: ORDER,
    userId: BUYER,
    reason: 'The course was <b>fully</b> watched & downloaded.',
    rejectedAt: NOW,
    ...overrides,
  });

const refundRequested = (overrides: Record<string, unknown> = {}): EventEnvelope =>
  envelope('RefundRequested', {
    refundId: REFUND,
    orderId: ORDER,
    orderLineId: LINE,
    userId: BUYER,
    courseId: COURSE,
    currency: 'USD',
    amount: '39.99',
    reasonCode: 'NOT_AS_EXPECTED',
    requestedAt: NOW,
    ...overrides,
  });

class FakeContacts extends UserContactReader {
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(): Promise<UserContact | null> {
    return this.contact;
  }
}

class FakeAdmins extends AdminRecipientsReader {
  constructor(private readonly admins: AdminRecipient[]) {
    super();
  }
  override async list(): Promise<AdminRecipient[]> {
    return this.admins;
  }
}

class FakeCommerce extends CommerceMailReader {
  readonly lookups: string[] = [];
  constructor(private readonly context: RefundMailContext | null) {
    super();
  }
  override async refund(_trx: unknown, refundId: string): Promise<RefundMailContext | null> {
    this.lookups.push(`refund:${refundId}`);
    return this.context;
  }
  override async orderNumber(_trx: unknown, orderId: string): Promise<string | null> {
    this.lookups.push(`order:${orderId}`);
    return this.context?.orderNumber ?? null;
  }
}

/** Fails the n-th send (0-based) with an SMTP outage. */
class FlakyMailer extends RecordingMailer {
  private count = 0;
  constructor(private readonly failAt: number) {
    super();
  }
  override async send(message: MailMessage): Promise<MailSendResult> {
    if (this.count++ === this.failAt) throw new DependencyUnavailableError('smtp');
    return super.send(message);
  }
}

const links = new CommerceLinks(fakeConfig({ ADMIN_APP_ORIGIN: 'http://localhost:3002' }));
const jane: UserContact = { email: 'jane@example.com', displayName: 'Jane <Doe>' };
const refundRow: RefundMailContext = {
  orderId: ORDER,
  orderNumber: '1042',
  courseTitle: 'Rust & You',
  amount: '39.99',
  currency: 'USD',
};
const admins: AdminRecipient[] = [
  { userId: ADMIN_A, email: 'a@example.com', displayName: 'Admin A' },
  { userId: ADMIN_B, email: 'b@example.com', displayName: 'Admin B' },
];

describe('ReceiptMailerHandler', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('mails the buyer the receipt link, lines and total, Message-ID from the event', async () => {
    await new ReceiptMailerHandler(new FakeContacts(jane), mailer, links).handle(
      orderPaid(),
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane@example.com',
      subject: 'Your receipt for order #1042',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain(
      `View your receipt: http://localhost:3000/account/orders/${ORDER}/receipt`,
    );
    expect(mail?.text).toContain('"Rust <for> Everyone": $49.99 − $10.00 (discount) = $39.99');
    expect(mail?.text).toContain('Total: $39.99');
    expect(mail?.html).toContain('Hi Jane &lt;Doe&gt;,');
  });

  it('a zero-total order (provider NONE) gets the "nothing was charged" receipt', async () => {
    await new ReceiptMailerHandler(new FakeContacts(jane), mailer, links).handle(
      orderPaid({ provider: 'NONE', totalAmount: '0.00' }),
      FAKE_TRX,
    );
    expect(mailer.sent[0]?.text).toContain('nothing was charged');
  });

  it('skips an unknown buyer; dead-letters an unsupported version and a broken payload', async () => {
    const handler = new ReceiptMailerHandler(new FakeContacts(null), mailer, links);
    await handler.handle(orderPaid(), FAKE_TRX);
    expect(mailer.sent).toHaveLength(0);
    await expect(handler.handle(orderPaid({}, 2), FAKE_TRX)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(
      handler.handle(orderPaid({ totalAmount: '39.9' }), FAKE_TRX),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('propagates an SMTP outage so the event is retried', async () => {
    await expect(
      new ReceiptMailerHandler(new FakeContacts(jane), new FlakyMailer(0), links).handle(
        orderPaid(),
        FAKE_TRX,
      ),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
  });
});

describe('student refund mailers', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('RefundSucceeded: snapshot title + order number from the refund row, amount from the event', async () => {
    const commerce = new FakeCommerce(refundRow);
    await new RefundSucceededMailerHandler(new FakeContacts(jane), commerce, mailer, links).handle(
      refundSucceeded({ amount: '39.99' }),
      FAKE_TRX,
    );
    expect(commerce.lookups).toEqual([`refund:${REFUND}`]);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane@example.com',
      subject: 'Your refund was processed',
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain('We refunded $39.99 for "Rust & You" (order #1042)');
    expect(mail?.text).toContain(`View your order: http://localhost:3000/account/orders/${ORDER}`);
  });

  it('RefundSucceeded: falls back to neutral wording when the refund row is gone', async () => {
    await new RefundSucceededMailerHandler(
      new FakeContacts(jane),
      new FakeCommerce(null),
      mailer,
      links,
    ).handle(refundSucceeded(), FAKE_TRX);
    expect(mailer.sent[0]?.text).toContain('for your course (your order)');
  });

  it('RefundRejected: the escaped reason and the order link; skips an unknown user', async () => {
    await new RefundRejectedMailerHandler(
      new FakeContacts(jane),
      new FakeCommerce(refundRow),
      mailer,
      links,
    ).handle(refundRejected(), FAKE_TRX);
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('Your refund request was not approved');
    expect(mail?.text).toContain('Reason: The course was <b>fully</b> watched & downloaded.');
    expect(mail?.html).toContain('&lt;b&gt;fully&lt;/b&gt; watched &amp; downloaded');
    expect(mail?.html).not.toContain('<b>fully');
    await new RefundRejectedMailerHandler(
      new FakeContacts(null),
      new FakeCommerce(refundRow),
      mailer,
      links,
    ).handle(refundRejected(), FAKE_TRX);
    expect(mailer.sent).toHaveLength(1);
  });

  it('RefundRejected: dead-letters a too-short reason (contract)', async () => {
    await expect(
      new RefundRejectedMailerHandler(
        new FakeContacts(jane),
        new FakeCommerce(refundRow),
        mailer,
        links,
      ).handle(refundRejected({ reason: 'no' }), FAKE_TRX),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('RefundRequested: the under-review acknowledgement with the reason label', async () => {
    await new RefundUnderReviewMailerHandler(
      new FakeContacts(jane),
      new FakeCommerce(refundRow),
      mailer,
      links,
    ).handle(refundRequested(), FAKE_TRX);
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('We received your refund request');
    expect(mail?.messageId).toBe(`<${EVENT}@udemy.local>`);
    expect(mail?.text).toContain('Reason given: The course is not what I expected');
  });
});

describe('admin alert mailers', () => {
  let mailer: RecordingMailer;
  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  const sender = (list: AdminRecipient[], m: RecordingMailer = mailer) =>
    new AdminAlertSender(new FakeAdmins(list), m);

  it('OrderPaymentMismatch: one mail per admin, per-recipient Message-ID, admin order link', async () => {
    const commerce = new FakeCommerce(refundRow);
    await new PaymentMismatchAlertHandler(sender(admins), commerce, links).handle(
      envelope('OrderPaymentMismatch', {
        orderId: ORDER,
        expected: { amount: '39.99', currency: 'USD' },
        received: { amount: '3.99', currency: 'USD' },
        providerEventId: 'evt_123',
        detectedAt: NOW,
      }),
      FAKE_TRX,
    );
    expect(commerce.lookups).toEqual([`order:${ORDER}`]);
    expect(mailer.sent.map((m) => [m.to, m.messageId])).toEqual([
      ['a@example.com', `<${EVENT}.${ADMIN_A}@udemy.local>`],
      ['b@example.com', `<${EVENT}.${ADMIN_B}@udemy.local>`],
    ]);
    expect(mailer.sent[0]?.subject).toBe('[Alert] Payment mismatch on order #1042');
    expect(mailer.sent[0]?.text).toContain(`Open the order: http://localhost:3002/orders/${ORDER}`);
    expect(mailer.sent[1]?.text).toContain('Hi Admin B,');
  });

  it('PaymentDisputed: sent to admins; nothing when there is no admin', async () => {
    const event = envelope('PaymentDisputed', {
      orderId: ORDER,
      paymentIntentId: 'pi_123',
      openedAt: NOW,
    });
    await new PaymentDisputedAlertHandler(sender([]), new FakeCommerce(refundRow), links).handle(
      event,
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(0);
    await new PaymentDisputedAlertHandler(
      sender(admins.slice(0, 1)),
      new FakeCommerce(refundRow),
      links,
    ).handle(event, FAKE_TRX);
    expect(mailer.sent[0]?.subject).toBe('[Alert] Payment disputed on order #1042');
    expect(mailer.sent[0]?.text).toContain('Payment intent: pi_123');
  });

  it('RefundRequested and RefundFailed link admins to the refund queue', async () => {
    await new RefundReviewAlertHandler(
      sender(admins.slice(0, 1)),
      new FakeCommerce(refundRow),
      links,
    ).handle(refundRequested(), FAKE_TRX);
    await new RefundFailedAlertHandler(
      sender(admins.slice(0, 1)),
      new FakeCommerce(refundRow),
      links,
    ).handle(
      envelope('RefundFailed', {
        refundId: REFUND,
        orderId: ORDER,
        failureCode: 'charge_already_refunded',
        attempt: 1,
        failedAt: NOW,
      }),
      FAKE_TRX,
    );
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      '[Review] Refund request on order #1042',
      '[Alert] Refund failed on order #1042',
    ]);
    for (const mail of mailer.sent) {
      expect(mail.text).toContain('Open the refund queue: http://localhost:3002/refunds');
    }
  });

  it('propagates an SMTP outage midway (the whole event is retried)', async () => {
    const flaky = new FlakyMailer(1);
    await expect(
      new PaymentDisputedAlertHandler(
        sender(admins, flaky),
        new FakeCommerce(refundRow),
        links,
      ).handle(
        envelope('PaymentDisputed', { orderId: ORDER, paymentIntentId: 'pi_1', openedAt: NOW }),
        FAKE_TRX,
      ),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(flaky.sent).toHaveLength(1);
  });
});
