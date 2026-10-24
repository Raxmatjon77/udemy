import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { DATABASE } from '@udemy/nest-common';
import { Mailer } from '@udemy/nest-common/mail';
import { ObjectStorage } from '@udemy/storage';
import { describe, expect, it } from 'vitest';
import { EngagementModule } from './engagement/engagement.module';
import { RecordingMailer } from './identity/testing/identity-mail.fakes';
import { LearningModule } from './learning/learning.module';
import { ADVISORY_LOCK_KEYS } from './maintenance/advisory-lock-keys';
import { EventHandlerRegistry } from './messaging/event-handler.registry';
import { NotificationsModule } from './notifications/notifications.module';
import {
  notificationsConfig,
  RecordingRealtime,
} from './notifications/testing/notifications.fakes';
import { WorkerConfigService } from './shared/config';
import { RealtimeEmitter } from './shared/realtime';
import { createFakeDatabase } from './testing/fake-database';

/** Stands in for the app's global modules (config, mail, database, storage, realtime). */
@Global()
@Module({
  providers: [
    {
      provide: WorkerConfigService,
      useFactory: () => {
        const base = notificationsConfig();
        const off: Record<string, unknown> = {
          NOTIFICATION_FANOUT_ENABLED: false,
          NOTIFICATION_RETENTION_ENABLED: false,
          LEARNING_MAINTENANCE_ENABLED: false,
        };
        return { get: (key: string) => (key in off ? off[key] : base.get(key as never)) };
      },
    },
    { provide: Mailer, useClass: RecordingMailer },
    { provide: DATABASE, useFactory: () => createFakeDatabase().db },
    { provide: ObjectStorage, useValue: {} },
    { provide: RealtimeEmitter, useFactory: () => new RecordingRealtime().asEmitter() },
  ],
  exports: [WorkerConfigService, Mailer, DATABASE, ObjectStorage, RealtimeEmitter],
})
class FakeGlobalsModule {}

/**
 * The Phase 5 consumer modules resolve their providers (Nest DI), the scheduled jobs boot with
 * their env gates off, and the registry discovers every handler with its pinned consumer name
 * and topic (compared sorted: discovery order is not a contract).
 */
describe('Phase 5 handler wiring', () => {
  it('registers the learning, engagement and notifications handlers on their topics', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeGlobalsModule,
        DiscoveryModule,
        ScheduleModule.forRoot(),
        LearningModule,
        EngagementModule,
        NotificationsModule,
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

    expect(registry.topics().sort()).toEqual([
      'engagement.announcement',
      'engagement.course_review',
      'engagement.question',
      'enrollment.enrollment',
      'learning.certificate',
      'learning.progress',
      'media.asset',
    ]);
    expect(names('learning.progress', 'CourseCompleted')).toEqual(['learning.certificate-issuer']);
    expect(names('learning.certificate', 'CertificateIssued')).toEqual([
      'notifications.certificate-notifier',
    ]);
    expect(names('enrollment.enrollment', 'EnrollmentRevoked')).toEqual([
      'engagement.review-enrollment-sync.enrollment-revoked',
      'learning.certificate-revoker.enrollment-revoked',
      'notifications.room-revoker',
    ]);
    expect(names('enrollment.enrollment', 'EnrollmentGranted')).toEqual([
      'engagement.review-enrollment-sync.enrollment-granted',
      'learning.certificate-revoker.enrollment-granted',
    ]);
    expect(names('engagement.course_review', 'ReviewPosted')).toEqual([
      'engagement.rating-aggregator.review-posted',
      'notifications.review-notifier.review-posted',
    ]);
    expect(names('engagement.course_review', 'ReviewEdited')).toEqual([
      'engagement.rating-aggregator.review-edited',
      'notifications.review-notifier.review-edited',
    ]);
    expect(names('engagement.course_review', 'ReviewDeleted')).toEqual([
      'engagement.rating-aggregator.review-deleted',
    ]);
    expect(names('engagement.course_review', 'ReviewHidden')).toEqual([
      'engagement.rating-aggregator.review-hidden',
      'notifications.moderation-notifier.review-hidden',
    ]);
    expect(names('engagement.course_review', 'ReviewRestored')).toEqual([
      'engagement.rating-aggregator.review-restored',
    ]);
    expect(names('engagement.course_review', 'ReviewReplyPosted')).toEqual([
      'notifications.review-notifier.reply-posted',
    ]);
    expect(names('engagement.course_review', 'ReviewReplyHidden')).toEqual([
      'notifications.moderation-notifier.review-reply-hidden',
    ]);
    expect(names('engagement.question', 'QuestionPosted')).toEqual([
      'notifications.qa-notifier.question-posted',
    ]);
    expect(names('engagement.question', 'AnswerPosted')).toEqual([
      'notifications.qa-notifier.answer-posted',
    ]);
    expect(names('engagement.question', 'QuestionResolved')).toEqual([
      'notifications.qa-notifier.question-resolved',
    ]);
    expect(names('engagement.question', 'QuestionHidden')).toEqual([
      'notifications.moderation-notifier.question-hidden',
    ]);
    expect(names('engagement.question', 'AnswerHidden')).toEqual([
      'notifications.moderation-notifier.answer-hidden',
    ]);
    expect(names('engagement.announcement', 'AnnouncementPosted')).toEqual([
      'notifications.announcement-fanout-enqueuer',
    ]);
    expect(names('engagement.announcement', 'AnnouncementDeleted')).toEqual([
      'notifications.moderation-notifier.announcement-deleted',
    ]);
    expect(names('media.asset', 'MediaReady')).toEqual([
      'notifications.media-notifier.media-ready',
    ]);
    expect(names('media.asset', 'MediaFailed')).toEqual([
      'notifications.media-notifier.media-failed',
    ]);
    await moduleRef.close();
  });

  it('the Phase 5 worker job locks are _07 and _08', () => {
    expect(ADVISORY_LOCK_KEYS.notificationRetention).toBe(504196069639);
    expect(ADVISORY_LOCK_KEYS.learningMaintenance).toBe(504196069640);
  });
});
