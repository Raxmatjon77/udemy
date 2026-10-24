import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { UsersModule } from '../users';
import { EngagementSettings } from './application/engagement-settings';
import { PeopleDirectory } from './application/people';
import { EngagementEventPublisher } from './application/ports/engagement-event.publisher';
import { EngagementRateLimiter } from './application/ports/engagement-rate-limiter';
import { ReportRepository } from './application/ports/report.repository';
import { ReviewRepository } from './application/ports/review.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { WishlistRepository } from './application/ports/wishlist.repository';
import {
  REPORT_SUBJECT_HANDLERS,
  type ReportSubjectHandler,
} from './application/report-subjects/report-subject.handler';
import { ReviewReplyReportSubject } from './application/report-subjects/review-reply.report-subject';
import { ReviewReportSubject } from './application/report-subjects/review.report-subject';
import { ReviewEligibility } from './application/review-eligibility';
import { AddToWishlistCommand } from './application/use-cases/add-to-wishlist.command';
import { DeleteMyReviewCommand } from './application/use-cases/delete-my-review.command';
import { DeleteReviewReplyCommand } from './application/use-cases/delete-review-reply.command';
import { GetMyCourseReviewQuery } from './application/use-cases/get-my-course-review.query';
import { GetRatingsQuery } from './application/use-cases/get-ratings.query';
import { GetWishlistStatesQuery } from './application/use-cases/get-wishlist-states.query';
import { ListCourseReviewsQuery } from './application/use-cases/list-course-reviews.query';
import { ListPublicReviewsQuery } from './application/use-cases/list-public-reviews.query';
import { ListWishlistQuery } from './application/use-cases/list-wishlist.query';
import { RemoveFromWishlistCommand } from './application/use-cases/remove-from-wishlist.command';
import { ReportContentCommand } from './application/use-cases/report-content.command';
import { UpsertMyReviewCommand } from './application/use-cases/upsert-my-review.command';
import { UpsertReviewReplyCommand } from './application/use-cases/upsert-review-reply.command';
import { KyselyReportRepository } from './infrastructure/kysely-report.repository';
import { KyselyReviewRepository } from './infrastructure/kysely-review.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { KyselyWishlistRepository } from './infrastructure/kysely-wishlist.repository';
import { OutboxEngagementEventPublisher } from './infrastructure/outbox-engagement-event.publisher';
import { RedisEngagementRateLimiter } from './infrastructure/redis-engagement-rate-limiter';
import { ContentReportsController } from './presentation/content-reports.controller';
import { CourseReviewsController } from './presentation/course-reviews.controller';
import { MyReviewsController } from './presentation/my-reviews.controller';
import { MyWishlistController } from './presentation/my-wishlist.controller';
import { PublicEngagementController } from './presentation/public-engagement.controller';

/** `EngagementSettings` from the validated `ENGAGEMENT_*` env. */
export function engagementSettingsFrom(config: AppConfigService): EngagementSettings {
  return new EngagementSettings(config.get('ENGAGEMENT_AUTO_HIDE_REPORTS'));
}

/**
 * Every reportable subject type of this module. P5-T13 appends its QUESTION / ANSWER handlers
 * here (providers + inject), and its routes to `ContentReportsController`.
 */
const REPORT_SUBJECT_HANDLER_CLASSES = [ReviewReportSubject, ReviewReplyReportSubject] as const;

/**
 * engagement A (Phase 5 learning experience design §3–§9, P5-T12): reviews and instructor
 * replies (eligibility: an ACTIVE enrollment, >= 1 completed lecture, not the owner), the public
 * reviews and the rating read model, the wishlist, and reports with auto-hide for reviews and
 * replies. Q&A, announcements, their reports and the admin moderation routes are P5-T13.
 *
 * Depends on catalog (`CatalogFacade`: live courses, course cards), enrollment
 * (`EnrollmentFacade.hasAccess`) and users (`UsersFacade`: public profiles), plus the global
 * DatabaseModule, OutboxModule, RedisModule, AppConfigModule, AuthSupportModule and the
 * `LECTURE_COMPLETIONS` port (AppModule binds it; learning implements it from P5-T10). The
 * course ownership resolver of `@CheckPolicy({ resource: 'course' })` is catalog's.
 *
 * Exports nothing: no in-process consumer (design §3); the worker reacts to its events.
 */
@Module({
  imports: [CatalogModule, EnrollmentModule, UsersModule],
  controllers: [
    PublicEngagementController,
    MyReviewsController,
    CourseReviewsController,
    MyWishlistController,
    ContentReportsController,
  ],
  providers: [
    // Configuration, persistence, events, limits
    { provide: EngagementSettings, inject: [AppConfigService], useFactory: engagementSettingsFrom },
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: ReviewRepository, useClass: KyselyReviewRepository },
    { provide: WishlistRepository, useClass: KyselyWishlistRepository },
    { provide: ReportRepository, useClass: KyselyReportRepository },
    { provide: EngagementEventPublisher, useClass: OutboxEngagementEventPublisher },
    { provide: EngagementRateLimiter, useClass: RedisEngagementRateLimiter },

    // Application services
    PeopleDirectory,
    ReviewEligibility,
    ...REPORT_SUBJECT_HANDLER_CLASSES,
    {
      provide: REPORT_SUBJECT_HANDLERS,
      inject: [...REPORT_SUBJECT_HANDLER_CLASSES],
      useFactory: (...handlers: ReportSubjectHandler[]): readonly ReportSubjectHandler[] =>
        handlers,
    },

    // Use cases: reviews, replies, ratings
    GetRatingsQuery,
    ListPublicReviewsQuery,
    GetMyCourseReviewQuery,
    UpsertMyReviewCommand,
    DeleteMyReviewCommand,
    ListCourseReviewsQuery,
    UpsertReviewReplyCommand,
    DeleteReviewReplyCommand,
    // Use cases: wishlist
    ListWishlistQuery,
    GetWishlistStatesQuery,
    AddToWishlistCommand,
    RemoveFromWishlistCommand,
    // Use cases: reports
    ReportContentCommand,
  ],
})
export class EngagementModule {}
