import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { UsersModule } from '../users';
import { EngagementSettings } from './application/engagement-settings';
import { ModerationEvents } from './application/moderation-events';
import { ModerationReader } from './application/moderation-reader';
import { PeopleDirectory } from './application/people';
import { AnnouncementRepository } from './application/ports/announcement.repository';
import { EngagementEventPublisher } from './application/ports/engagement-event.publisher';
import { EngagementRateLimiter } from './application/ports/engagement-rate-limiter';
import { ModerationRepository } from './application/ports/moderation.repository';
import { QaRepository } from './application/ports/qa.repository';
import { QaHints } from './application/ports/qa-hints';
import { ReportRepository } from './application/ports/report.repository';
import { ReviewRepository } from './application/ports/review.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { WishlistRepository } from './application/ports/wishlist.repository';
import { QaAccess } from './application/qa-access';
import { QaPresenter } from './application/qa-presenter';
import { AnswerReportSubject } from './application/report-subjects/answer.report-subject';
import { QuestionReportSubject } from './application/report-subjects/question.report-subject';
import {
  REPORT_SUBJECT_HANDLERS,
  type ReportSubjectHandler,
} from './application/report-subjects/report-subject.handler';
import { ReviewReplyReportSubject } from './application/report-subjects/review-reply.report-subject';
import { ReviewReportSubject } from './application/report-subjects/review.report-subject';
import { ReviewEligibility } from './application/review-eligibility';
import { AddToWishlistCommand } from './application/use-cases/add-to-wishlist.command';
import { AskQuestionCommand } from './application/use-cases/ask-question.command';
import { DeleteAnnouncementCommand } from './application/use-cases/delete-announcement.command';
import { DeleteAnswerCommand } from './application/use-cases/delete-answer.command';
import { DeleteMyReviewCommand } from './application/use-cases/delete-my-review.command';
import { DeleteQuestionCommand } from './application/use-cases/delete-question.command';
import { DeleteReviewReplyCommand } from './application/use-cases/delete-review-reply.command';
import { EditAnswerCommand } from './application/use-cases/edit-answer.command';
import { EditQuestionCommand } from './application/use-cases/edit-question.command';
import { GetMyCourseReviewQuery } from './application/use-cases/get-my-course-review.query';
import { GetQuestionQuery } from './application/use-cases/get-question.query';
import { GetRatingsQuery } from './application/use-cases/get-ratings.query';
import { GetWishlistStatesQuery } from './application/use-cases/get-wishlist-states.query';
import { InstructorQaInboxQuery } from './application/use-cases/instructor-qa-inbox.query';
import { ListAnnouncementsQuery } from './application/use-cases/list-announcements.query';
import { ListAnswersQuery } from './application/use-cases/list-answers.query';
import { ListCourseAnnouncementsQuery } from './application/use-cases/list-course-announcements.query';
import { ListCourseReviewsQuery } from './application/use-cases/list-course-reviews.query';
import { ListModerationQueueQuery } from './application/use-cases/list-moderation-queue.query';
import { ListPublicReviewsQuery } from './application/use-cases/list-public-reviews.query';
import { ListQuestionsQuery } from './application/use-cases/list-questions.query';
import { ListWishlistQuery } from './application/use-cases/list-wishlist.query';
import { ModerateContentCommand } from './application/use-cases/moderate-content.command';
import { PostAnnouncementCommand } from './application/use-cases/post-announcement.command';
import { PostAnswerCommand } from './application/use-cases/post-answer.command';
import { RemoveFromWishlistCommand } from './application/use-cases/remove-from-wishlist.command';
import { ReportContentCommand } from './application/use-cases/report-content.command';
import { SetAcceptedAnswerCommand } from './application/use-cases/set-accepted-answer.command';
import { UpsertMyReviewCommand } from './application/use-cases/upsert-my-review.command';
import { UpsertReviewReplyCommand } from './application/use-cases/upsert-review-reply.command';
import { VoteCommand } from './application/use-cases/vote.command';
import { KyselyAnnouncementRepository } from './infrastructure/kysely-announcement.repository';
import { KyselyModerationRepository } from './infrastructure/kysely-moderation.repository';
import { KyselyQaRepository } from './infrastructure/kysely-qa.repository';
import { KyselyReportRepository } from './infrastructure/kysely-report.repository';
import { KyselyReviewRepository } from './infrastructure/kysely-review.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { KyselyWishlistRepository } from './infrastructure/kysely-wishlist.repository';
import { OutboxEngagementEventPublisher } from './infrastructure/outbox-engagement-event.publisher';
import { RealtimeQaHints } from './infrastructure/realtime-qa-hints';
import { RedisEngagementRateLimiter } from './infrastructure/redis-engagement-rate-limiter';
import { AdminModerationController } from './presentation/admin-moderation.controller';
import { ContentReportsController } from './presentation/content-reports.controller';
import { CourseAnnouncementsController } from './presentation/course-announcements.controller';
import { CourseQuestionsController } from './presentation/course-questions.controller';
import { CourseReviewsController } from './presentation/course-reviews.controller';
import { InstructorQaController } from './presentation/instructor-qa.controller';
import { MyAnnouncementsController } from './presentation/my-announcements.controller';
import { MyReviewsController } from './presentation/my-reviews.controller';
import { MyWishlistController } from './presentation/my-wishlist.controller';
import { PublicEngagementController } from './presentation/public-engagement.controller';

/** `EngagementSettings` from the validated `ENGAGEMENT_*` env. */
export function engagementSettingsFrom(config: AppConfigService): EngagementSettings {
  return new EngagementSettings(config.get('ENGAGEMENT_AUTO_HIDE_REPORTS'));
}

/** Every reportable subject type of this module (`ReportContentCommand` dispatches on it). */
const REPORT_SUBJECT_HANDLER_CLASSES = [
  ReviewReportSubject,
  ReviewReplyReportSubject,
  QuestionReportSubject,
  AnswerReportSubject,
] as const;

/**
 * The engagement context (Phase 5 learning experience design §3–§9):
 * - P5-T12: reviews and instructor replies (eligibility: an ACTIVE enrollment, >= 1 completed
 *   lecture, not the owner), the public reviews and the rating read model, the wishlist;
 * - P5-T13: Q&A (questions, answers, votes, accepted answers, title search, the instructor
 *   inbox) with post-commit `qa.changed` course-room hints, announcements (the per-course
 *   `anno` quota), and the admin moderation queue and actions;
 * - reports with auto-hide for all four subject types.
 *
 * Depends on catalog (`CatalogFacade`: live courses and lectures, course cards, owned course
 * ids), enrollment (`EnrollmentFacade.hasAccess`) and users (`UsersFacade`: public profiles),
 * plus the global DatabaseModule, OutboxModule, RedisModule, RealtimeModule (`RealtimeEmitter`),
 * AppConfigModule, AuthSupportModule and the `LECTURE_COMPLETIONS` port (AppModule binds it;
 * learning implements it from P5-T10). The course ownership resolver of
 * `@CheckPolicy({ resource: 'course' })` is catalog's.
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
    CourseQuestionsController,
    InstructorQaController,
    CourseAnnouncementsController,
    MyAnnouncementsController,
    AdminModerationController,
  ],
  providers: [
    // Configuration, persistence, events, limits
    { provide: EngagementSettings, inject: [AppConfigService], useFactory: engagementSettingsFrom },
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: ReviewRepository, useClass: KyselyReviewRepository },
    { provide: WishlistRepository, useClass: KyselyWishlistRepository },
    { provide: ReportRepository, useClass: KyselyReportRepository },
    { provide: QaRepository, useClass: KyselyQaRepository },
    { provide: AnnouncementRepository, useClass: KyselyAnnouncementRepository },
    { provide: ModerationRepository, useClass: KyselyModerationRepository },
    { provide: QaHints, useClass: RealtimeQaHints },
    { provide: EngagementEventPublisher, useClass: OutboxEngagementEventPublisher },
    { provide: EngagementRateLimiter, useClass: RedisEngagementRateLimiter },

    // Application services
    PeopleDirectory,
    ReviewEligibility,
    QaAccess,
    QaPresenter,
    ModerationEvents,
    ModerationReader,
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
    // Use cases: Q&A
    ListQuestionsQuery,
    GetQuestionQuery,
    ListAnswersQuery,
    AskQuestionCommand,
    EditQuestionCommand,
    DeleteQuestionCommand,
    PostAnswerCommand,
    EditAnswerCommand,
    DeleteAnswerCommand,
    VoteCommand,
    SetAcceptedAnswerCommand,
    InstructorQaInboxQuery,
    // Use cases: announcements
    ListAnnouncementsQuery,
    ListCourseAnnouncementsQuery,
    PostAnnouncementCommand,
    DeleteAnnouncementCommand,
    // Use cases: reports and moderation
    ReportContentCommand,
    ListModerationQueueQuery,
    ModerateContentCommand,
  ],
})
export class EngagementModule {}
