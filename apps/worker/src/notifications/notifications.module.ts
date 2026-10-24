import { Module } from '@nestjs/common';
import { HmacUnsubscribeTokenCodec } from '@udemy/nest-common/unsubscribe';
import { WorkerConfigService } from '../shared/config';
import { AdminRecipientsReader } from '../shared/mail/admin-recipients.reader';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { NotificationDeliverer } from './delivery/notification-deliverer';
import { NotificationPreferencesReader } from './delivery/notification-preferences.reader';
import { NotificationStore } from './delivery/notification.store';
import { FanoutRunner } from './fanout/fanout-runner';
import { FanoutJob } from './fanout/fanout.job';
import { AnnouncementFanoutEnqueuer } from './handlers/announcement-fanout-enqueuer.handler';
import { CertificateIssuedNotifier } from './handlers/certificate-notifier.handler';
import { MediaFailedNotifier, MediaReadyNotifier } from './handlers/media-notifier.handlers';
import {
  AnnouncementDeletedNotifier,
  AnswerHiddenNotifier,
  HiddenContentNotices,
  QuestionHiddenNotifier,
  ReviewHiddenNotifier,
  ReviewReplyHiddenNotifier,
} from './handlers/moderation-notifier.handlers';
import {
  QaAnswerPostedNotifier,
  QaQuestionPostedNotifier,
  QaQuestionResolvedNotifier,
} from './handlers/qa-notifier.handlers';
import {
  ReviewEditedNotifier,
  ReviewPostedNotifier,
  ReviewReplyPostedNotifier,
} from './handlers/review-notifier.handlers';
import { RoomRevokerHandler } from './handlers/room-revoker.handler';
import { NotificationLinks } from './mail/notification-links';
import { NotificationContextReader } from './persistence/notification-context.reader';
import { NotificationRetentionJob } from './retention/notification-retention.job';

/**
 * Worker side of notifications (Phase 5 design D14, D17, D18, §5 worker table, P5-T15): the
 * notifiers (fan-out on write per recipient: row + after-commit push + e-mail per preference),
 * the moderation redaction, the course-room revoker, the announcement fan-out (enqueuer +
 * leased `FanoutJob`) and the `NotificationRetentionJob` (`_07`).
 *
 * Uses the global DatabaseModule, MailModule, RealtimeModule (`RealtimeEmitter`, Redis),
 * WorkerConfigModule and ScheduleModule (MaintenanceModule's `forRoot`). The unsubscribe codec is
 * the shared `@udemy/nest-common/unsubscribe` one the api verifies with. Nothing is exported.
 */
@Module({
  providers: [
    {
      provide: HmacUnsubscribeTokenCodec,
      inject: [WorkerConfigService],
      useFactory: (config: WorkerConfigService): HmacUnsubscribeTokenCodec =>
        new HmacUnsubscribeTokenCodec(config.get('NOTIFICATIONS_UNSUBSCRIBE_SECRET')),
    },
    NotificationLinks,
    NotificationPreferencesReader,
    NotificationStore,
    NotificationContextReader,
    UserContactReader,
    AdminRecipientsReader,
    NotificationDeliverer,
    HiddenContentNotices,

    // Consumers
    QaQuestionPostedNotifier,
    QaAnswerPostedNotifier,
    QaQuestionResolvedNotifier,
    ReviewPostedNotifier,
    ReviewEditedNotifier,
    ReviewReplyPostedNotifier,
    CertificateIssuedNotifier,
    MediaReadyNotifier,
    MediaFailedNotifier,
    ReviewHiddenNotifier,
    ReviewReplyHiddenNotifier,
    QuestionHiddenNotifier,
    AnswerHiddenNotifier,
    AnnouncementDeletedNotifier,
    AnnouncementFanoutEnqueuer,
    RoomRevokerHandler,

    // Jobs
    FanoutRunner,
    FanoutJob,
    NotificationRetentionJob,
  ],
})
export class NotificationsModule {}
