import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Mailer } from '@udemy/nest-common/mail';
import { describe, expect, it } from 'vitest';
import { CatalogMailModule } from './catalog/catalog-mail.module';
import { CommerceMailModule } from './commerce/commerce-mail.module';
import { EnrollmentMailModule } from './enrollment/enrollment-mail.module';
import { fakeConfig, RecordingMailer } from './identity/testing/identity-mail.fakes';
import { EventHandlerRegistry } from './messaging/event-handler.registry';
import { PayoutsModule } from './payouts/payouts.module';
import { WorkerConfigService } from './shared/config';

/** Stands in for the app's global WorkerConfigModule and MailModule. */
@Global()
@Module({
  providers: [
    { provide: WorkerConfigService, useValue: fakeConfig({ ADMIN_APP_ORIGIN: 'http://a.test' }) },
    { provide: Mailer, useClass: RecordingMailer },
  ],
  exports: [WorkerConfigService, Mailer],
})
class FakeGlobalsModule {}

/**
 * The Phase 4 consumer modules resolve their providers (Nest DI), and the registry discovers
 * every handler with its pinned consumer name and topic (compared sorted: discovery order is not
 * a contract). The catalog module is included because it shares the moved AdminRecipientsReader.
 */
describe('Phase 4 handler wiring', () => {
  it('registers the commerce, enrollment and payouts handlers on their topics', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeGlobalsModule,
        DiscoveryModule,
        CatalogMailModule,
        CommerceMailModule,
        EnrollmentMailModule,
        PayoutsModule,
      ],
      providers: [EventHandlerRegistry],
    }).compile();
    await moduleRef.init();
    const registry = moduleRef.get(EventHandlerRegistry);

    const names = (topic: string, eventType: string): string[] =>
      registry
        .handlersFor(topic, eventType)
        .map((h) => h.consumerName)
        .sort();

    expect(registry.topics()).toEqual(
      expect.arrayContaining(['catalog.course', 'commerce.order', 'enrollment.enrollment']),
    );
    expect(names('commerce.order', 'OrderPaid')).toEqual([
      'commerce.receipt-mailer',
      'payouts.ledger-writer.order-paid',
    ]);
    expect(names('commerce.order', 'RefundSucceeded')).toEqual([
      'commerce.refund-mailer',
      'payouts.ledger-writer.refund-succeeded',
    ]);
    expect(names('commerce.order', 'RefundRequested')).toEqual([
      'commerce.admin-alert-mailer.refund-requested',
      'commerce.refund-under-review-mailer',
    ]);
    expect(names('commerce.order', 'RefundRejected')).toEqual(['commerce.refund-rejected-mailer']);
    expect(names('commerce.order', 'RefundFailed')).toEqual([
      'commerce.admin-alert-mailer.refund-failed',
    ]);
    expect(names('commerce.order', 'OrderPaymentMismatch')).toEqual([
      'commerce.admin-alert-mailer.payment-mismatch',
    ]);
    expect(names('commerce.order', 'PaymentDisputed')).toEqual([
      'commerce.admin-alert-mailer.payment-disputed',
    ]);
    expect(names('enrollment.enrollment', 'EnrollmentGranted')).toEqual([
      'enrollment.instructor-new-enrollment-mailer',
    ]);
    expect(names('catalog.course', 'CourseSubmittedForReview')).toEqual([
      'catalog.review-requested-mailer',
    ]);
    await moduleRef.close();
  });
});
