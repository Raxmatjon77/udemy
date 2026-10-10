import { randomBytes, randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { createCoupon, deleteTestData, uniqueCode } from '@udemy/db/testing';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstructorNewEnrollmentMailerHandler } from '../enrollment/handlers/instructor-new-enrollment-mailer.handler';
import { EnrollmentLinks } from '../enrollment/mail/enrollment-mail';
import { EnrolledCourseReader } from '../enrollment/persistence/enrolled-course.reader';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { AdminRecipientsReader } from '../shared/mail/admin-recipients.reader';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { seedDraftCourse } from '../testing/catalog-fixtures';
import {
  commerceEnvelope,
  orderPaidPayload,
  refundSucceededPayload,
  type SeededOrder,
  seedPaidOrder,
  seedRequestedRefund,
  seedSucceededRefund,
} from '../testing/commerce-fixtures';
import {
  deleteMail,
  deleteMailMatching,
  exactlyMails,
  insertTestUser,
  itSmtpHost,
  itSmtpPort,
  useIntegrationStack,
} from '../testing/integration';
import {
  AdminAlertSender,
  PaymentDisputedAlertHandler,
  PaymentMismatchAlertHandler,
} from './handlers/admin-alert-mailer.handlers';
import { ReceiptMailerHandler } from './handlers/receipt-mailer.handler';
import {
  RefundRejectedMailerHandler,
  RefundSucceededMailerHandler,
  RefundUnderReviewMailerHandler,
} from './handlers/refund-mailers.handlers';
import { CommerceLinks } from './mail/commerce-links';
import { CommerceMailReader } from './persistence/commerce-mail.reader';

const STUDENT = 'http://localhost:3000';
const INSTRUCTOR = 'http://localhost:3001';
const ADMIN = 'http://localhost:3002';

/**
 * The `commerce.order` mailers and the flagged `enrollment.enrollment` mailer with their real
 * adapters: Kysely against the dev Postgres (orders seeded with the `@udemy/db/testing`
 * commerce fixtures, titles from the order_lines snapshot), SMTP to Mailpit and the real
 * idempotent processor. Events are built in memory with `it.`-prefixed consumer names, so a
 * running worker never sees them. Each mailer delivers exactly once despite a redelivery.
 */
describe('commerce and enrollment mailers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const subjects: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let processor: IdempotentEventProcessor;
  const handlers: Record<string, RegisteredEventHandler> = {};

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    mailer = new SmtpMailer({
      host: itSmtpHost(),
      port: itSmtpPort(),
      from: 'Udemy Clone <no-reply@udemy.local>',
      pool: false,
    });
    const config = fakeConfig({
      ADMIN_APP_ORIGIN: ADMIN,
      ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: true,
    });
    const contacts = new UserContactReader();
    const commerce = new CommerceMailReader();
    const links = new CommerceLinks(config);
    const alerts = new AdminAlertSender(new AdminRecipientsReader(), mailer);
    const register = (
      key: string,
      eventType: string,
      name: string,
      handler: RegisteredEventHandler['handler'],
      topic = 'commerce.order',
    ) => {
      handlers[key] = { topic, eventType, consumerName: `it.${name}`, handler };
    };
    register(
      'receipt',
      'OrderPaid',
      'commerce.receipt-mailer',
      new ReceiptMailerHandler(contacts, mailer, links),
    );
    register(
      'refund',
      'RefundSucceeded',
      'commerce.refund-mailer',
      new RefundSucceededMailerHandler(contacts, commerce, mailer, links),
    );
    register(
      'rejected',
      'RefundRejected',
      'commerce.refund-rejected-mailer',
      new RefundRejectedMailerHandler(contacts, commerce, mailer, links),
    );
    register(
      'underReview',
      'RefundRequested',
      'commerce.refund-under-review-mailer',
      new RefundUnderReviewMailerHandler(contacts, commerce, mailer, links),
    );
    register(
      'mismatch',
      'OrderPaymentMismatch',
      'commerce.admin-alert-mailer.payment-mismatch',
      new PaymentMismatchAlertHandler(alerts, commerce, links),
    );
    register(
      'disputed',
      'PaymentDisputed',
      'commerce.admin-alert-mailer.payment-disputed',
      new PaymentDisputedAlertHandler(alerts, commerce, links),
    );
    const enrollmentHandler = (enabled: boolean) => {
      const flagged = fakeConfig({ ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: enabled });
      return new InstructorNewEnrollmentMailerHandler(
        flagged,
        new EnrolledCourseReader(),
        contacts,
        mailer!,
        new EnrollmentLinks(flagged),
      );
    };
    register(
      'enrollmentOn',
      'EnrollmentGranted',
      'enrollment.instructor-new-enrollment-mailer',
      enrollmentHandler(true),
      'enrollment.enrollment',
    );
    register(
      'enrollmentOff',
      'EnrollmentGranted',
      'enrollment.instructor-new-enrollment-mailer.off',
      enrollmentHandler(false),
      'enrollment.enrollment',
    );
    processor = new IdempotentEventProcessor(it_.db);
  });

  afterAll(async () => {
    mailer?.close();
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    if (userIds.length > 0) {
      await it_.db.deleteFrom('access.userRoles').where('userId', 'in', userIds).execute();
    }
    // commerce, catalog and payouts rows of these users, then the users
    await deleteTestData(it_.db, userIds);
    await Promise.all(emails.map((e) => deleteMail(e)));
    // Admin alerts also reached the dev stack's own admins: remove those by subject.
    await Promise.all(subjects.map((s) => deleteMailMatching(`subject:"${s}"`)));
  });

  async function user(
    tag: string,
    role?: 'ADMIN' | 'INSTRUCTOR',
  ): Promise<{ id: string; email: string }> {
    const created = await insertTestUser(it_.db, { tag, displayName: `${tag} <IT>`, role });
    userIds.push(created.id);
    emails.push(created.email);
    return created;
  }

  async function paidOrder(options: { coupon?: boolean } = {}): Promise<{
    order: SeededOrder;
    buyer: { id: string; email: string };
  }> {
    const buyer = await user('buyer');
    const instructor = await user('instructor', 'INSTRUCTOR');
    const couponCode = uniqueCode('ITM');
    const couponId =
      options.coupon === true
        ? await createCoupon(it_.db, { createdBy: instructor.id, code: couponCode, percentOff: 20 })
        : undefined;
    const tag = randomBytes(3).toString('hex');
    const order = await seedPaidOrder(it_.db, {
      buyerId: buyer.id,
      lines: [
        {
          instructorId: instructor.id,
          listAmount: '49.99',
          courseTitle: `Rust <IT> ${tag}`,
          couponId,
        },
        { instructorId: instructor.id, listAmount: '19.99', courseTitle: `Go & IT ${tag}` },
      ],
    });
    return { order, buyer };
  }

  function track(envelope: EventEnvelope): EventEnvelope {
    eventIds.push(envelope.eventId);
    return envelope;
  }

  /** Processes the event twice (a Kafka redelivery): the second is a duplicate. */
  async function deliverTwice(key: string, event: EventEnvelope): Promise<void> {
    const registered = handlers[key];
    if (registered === undefined) throw new Error(`no handler ${key}`);
    await expect(processor.process(registered, event)).resolves.toBe('processed');
    await expect(processor.process(registered, event)).resolves.toBe('duplicate');
  }

  it('OrderPaid -> exactly one receipt with lines, the coupon discount, total and receipt link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { order, buyer } = await paidOrder({ coupon: true });
    const [rust, go] = order.lines;
    expect(rust?.discountAmount).toBe('10.00');
    const event = track(commerceEnvelope('OrderPaid', order.orderId, orderPaidPayload(order)));

    await deliverTwice('receipt', event);

    const mail = (await exactlyMails(buyer.email, 1))[0];
    expect(mail?.Subject).toBe(`Your receipt for order #${order.orderNumber}`);
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mail?.Text).toContain(
      `"${rust?.courseTitle}": $49.99 − $10.00 (coupon ${rust?.couponCode}) = $39.99`,
    );
    expect(mail?.Text).toContain(`"${go?.courseTitle}": $19.99`);
    expect(mail?.Text).toContain('Total: $59.98');
    const receiptUrl = `${STUDENT}/account/orders/${order.orderId}/receipt`;
    expect(mail?.Text).toContain(`View your receipt: ${receiptUrl}`);
    expect(mail?.HTML).toContain(`href="${receiptUrl}"`);
    expect(mail?.HTML).toContain('Rust &lt;IT&gt;');
    expect(mail?.HTML).not.toContain('Rust <IT>');
  }, 30_000);

  it('RefundSucceeded -> one refund mail with the snapshot title, order number and order link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { order, buyer } = await paidOrder();
    const line = order.lines[1]!;
    const refund = await seedSucceededRefund(it_.db, order, line);
    const event = track(
      commerceEnvelope(
        'RefundSucceeded',
        order.orderId,
        refundSucceededPayload(order, line, refund),
      ),
    );

    await deliverTwice('refund', event);

    const mail = (await exactlyMails(buyer.email, 1))[0];
    expect(mail?.Subject).toBe('Your refund was processed');
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mail?.Text).toContain(
      `We refunded $19.99 for "${line.courseTitle}" (order #${order.orderNumber})`,
    );
    expect(mail?.Text).toContain(`View your order: ${STUDENT}/account/orders/${order.orderId}`);
  }, 30_000);

  it('RefundRequested and RefundRejected -> one under-review and one rejection mail', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { order, buyer } = await paidOrder();
    const line = order.lines[0]!;
    const refundId = await seedRequestedRefund(it_.db, order, line);
    const requested = track(
      commerceEnvelope('RefundRequested', order.orderId, {
        refundId,
        orderId: order.orderId,
        orderLineId: line.id,
        userId: buyer.id,
        courseId: line.courseId,
        currency: 'USD',
        amount: line.finalAmount,
        reasonCode: 'QUALITY',
        requestedAt: new Date().toISOString(),
      }),
    );
    const reason = 'More than <b>half</b> of the lectures were downloaded & watched.';
    const rejected = track(
      commerceEnvelope('RefundRejected', order.orderId, {
        refundId,
        orderId: order.orderId,
        userId: buyer.id,
        reason,
        rejectedAt: new Date().toISOString(),
      }),
    );

    await deliverTwice('underReview', requested);
    await deliverTwice('rejected', rejected);

    const [review, rejection] = await exactlyMails(buyer.email, 2);
    expect(review?.Subject).toBe('We received your refund request');
    expect(`<${review?.MessageID}>`).toBe(eventMessageId(requested.eventId));
    expect(review?.Text).toContain(
      `refund request of $49.99 for "${line.courseTitle}" (order #${order.orderNumber})`,
    );
    expect(review?.Text).toContain('Reason given: Content or audio/video quality');
    expect(rejection?.Subject).toBe('Your refund request was not approved');
    expect(`<${rejection?.MessageID}>`).toBe(eventMessageId(rejected.eventId));
    expect(rejection?.Text).toContain(`Reason: ${reason}`);
    expect(rejection?.HTML).toContain('&lt;b&gt;half&lt;/b&gt;');
    expect(rejection?.Text).toContain(
      `View your order: ${STUDENT}/account/orders/${order.orderId}`,
    );
  }, 30_000);

  it('OrderPaymentMismatch and PaymentDisputed -> exactly one alert per admin with the admin order link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const { order, buyer } = await paidOrder();
    const adminA = await user('admin', 'ADMIN');
    const adminB = await user('admin', 'ADMIN');
    const mismatchSubject = `[Alert] Payment mismatch on order #${order.orderNumber}`;
    const disputeSubject = `[Alert] Payment disputed on order #${order.orderNumber}`;
    subjects.push(mismatchSubject, disputeSubject);
    const mismatch = track(
      commerceEnvelope('OrderPaymentMismatch', order.orderId, {
        orderId: order.orderId,
        expected: { amount: order.totalAmount, currency: 'USD' },
        received: { amount: '5.99', currency: 'USD' },
        providerEventId: `evt_it_${randomUUID()}`,
        detectedAt: new Date().toISOString(),
      }),
    );
    const disputed = track(
      commerceEnvelope('PaymentDisputed', order.orderId, {
        orderId: order.orderId,
        paymentIntentId: 'pi_it_123',
        openedAt: new Date().toISOString(),
      }),
    );

    await deliverTwice('mismatch', mismatch);
    await deliverTwice('disputed', disputed);

    for (const admin of [adminA, adminB]) {
      const [m, d] = await exactlyMails(admin.email, 2);
      expect(m?.Subject).toBe(mismatchSubject);
      expect(`<${m?.MessageID}>`).toBe(eventMessageId(`${mismatch.eventId}.${admin.id}`));
      expect(m?.Text).toContain(
        `reported $5.99 for order #${order.orderNumber}, but the order total is $69.98`,
      );
      expect(m?.Text).toContain(`Open the order: ${ADMIN}/orders/${order.orderId}`);
      expect(d?.Subject).toBe(disputeSubject);
      expect(`<${d?.MessageID}>`).toBe(eventMessageId(`${disputed.eventId}.${admin.id}`));
      expect(d?.Text).toContain('Payment intent: pi_it_123');
    }
    // The buyer is not an admin.
    await exactlyMails(buyer.email, 0);
  }, 30_000);

  it('EnrollmentGranted -> one mail to the course owner when flagged on, none when off', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const owner = await user('owner', 'INSTRUCTOR');
    const student = await user('student');
    const title = `IT enrolled ${randomBytes(3).toString('hex')}`;
    const { courseId } = await seedDraftCourse(it_.db, { ownerId: owner.id, title });
    const granted = (): EventEnvelope =>
      track({
        eventId: randomUUID(),
        eventType: 'EnrollmentGranted',
        aggregateType: 'enrollment.enrollment',
        aggregateId: randomUUID(),
        occurredAt: new Date().toISOString(),
        version: 1,
        payload: {
          enrollmentId: randomUUID(),
          userId: student.id,
          courseId,
          source: 'FREE',
          orderLineId: null,
          regrant: false,
          grantedAt: new Date().toISOString(),
        },
      });
    const on = granted();

    await deliverTwice('enrollmentOn', on);
    await deliverTwice('enrollmentOff', granted());

    const mail = (await exactlyMails(owner.email, 1))[0];
    expect(mail?.Subject).toBe(`New enrollment in "${title}"`);
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(on.eventId));
    expect(mail?.Text).toContain(`A new student enrolled in "${title}" for free`);
    expect(mail?.Text).toContain(`Open your course: ${INSTRUCTOR}/courses/${courseId}`);
    expect(mail?.Text).not.toContain(student.email);
    await exactlyMails(student.email, 0);
  }, 30_000);
});
