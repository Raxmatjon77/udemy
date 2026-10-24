import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { NotificationPreferenceRepository } from './application/ports/notification-preference.repository';
import { NotificationRepository } from './application/ports/notification.repository';
import { UnsubscribeTokenCodec } from './application/ports/unsubscribe-token.codec';
import { UnreadCountPublisher } from './application/unread-count.publisher';
import { AuthorizeCourseRoomQuery } from './application/use-cases/authorize-course-room.query';
import { GetNotificationPreferencesQuery } from './application/use-cases/get-notification-preferences.query';
import { GetUnreadCountQuery } from './application/use-cases/get-unread-count.query';
import { ListNotificationsQuery } from './application/use-cases/list-notifications.query';
import { MarkAllNotificationsReadCommand } from './application/use-cases/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './application/use-cases/mark-notification-read.command';
import { UnsubscribeCommand } from './application/use-cases/unsubscribe.command';
import { UpdateNotificationPreferencesCommand } from './application/use-cases/update-notification-preferences.command';
import { HmacUnsubscribeTokenCodec } from './infrastructure/hmac-unsubscribe-token.codec';
import { KyselyNotificationPreferenceRepository } from './infrastructure/kysely-notification-preference.repository';
import { KyselyNotificationRepository } from './infrastructure/kysely-notification.repository';
import { MyNotificationsController } from './presentation/my-notifications.controller';
import { NotificationPreferencesController } from './presentation/notification-preferences.controller';
import { NotificationsGateway } from './presentation/notifications.gateway';
import { UnsubscribeController } from './presentation/unsubscribe.controller';
import { UnsubscribeErrorsInterceptor } from './presentation/unsubscribe-errors.interceptor';

/**
 * notifications (Phase 5 learning experience design D14–D17, §5, §8, P5-T14): the inbox
 * (list, unread count, mark read), preferences (code defaults ⊕ overrides, locked pairs), the
 * RFC 8058 one-click unsubscribe (HMAC token) and `NotificationsGateway` (course-room
 * subscriptions on the shared realtime layer).
 *
 * Rows are written by the worker (fan-out on write, P5-T15); this module only reads them and
 * sets `read_at`. The WS ticket route, the handshake checks, the user room, the 15 min cap, the
 * inbound limit and the revoked-session sweep live in `shared/realtime` (`RealtimeModule`,
 * `RedisIoAdapter`), which is global; so do `RealtimeEmitter` (unread-count pushes) and the
 * global DatabaseModule, RedisModule (`RateLimiter`), AppConfigModule and AuthSupportModule.
 *
 * Depends on catalog (`CatalogFacade.getPublishedCourse`: course owner) and enrollment
 * (`EnrollmentFacade.hasAccess`) for course rooms only. Exports nothing (design §3).
 */
@Module({
  imports: [CatalogModule, EnrollmentModule],
  controllers: [
    MyNotificationsController,
    NotificationPreferencesController,
    UnsubscribeController,
  ],
  providers: [
    // Persistence and secrets
    { provide: NotificationRepository, useClass: KyselyNotificationRepository },
    { provide: NotificationPreferenceRepository, useClass: KyselyNotificationPreferenceRepository },
    { provide: UnsubscribeTokenCodec, useClass: HmacUnsubscribeTokenCodec },

    // Application services and use cases
    UnreadCountPublisher,
    ListNotificationsQuery,
    GetUnreadCountQuery,
    MarkNotificationReadCommand,
    MarkAllNotificationsReadCommand,
    GetNotificationPreferencesQuery,
    UpdateNotificationPreferencesCommand,
    UnsubscribeCommand,
    AuthorizeCourseRoomQuery,

    // Presentation
    UnsubscribeErrorsInterceptor,
    NotificationsGateway,
  ],
})
export class NotificationsModule {}
