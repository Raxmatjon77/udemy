import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { IdentityModule } from '../identity';
import { MediaModule } from '../media';
import { UsersModule } from '../users';
import { CatalogFacade } from './application/catalog.facade';
import { LectureAccessAuthorizer } from './application/lecture-access.authorizer';
import { PlaybackRateLimiter } from './application/ports/playback-rate-limiter';
import { PublicCatalogRepository } from './application/ports/public-catalog.repository';
import { BrowseCoursesQuery } from './application/use-cases/browse-courses.query';
import { GetCourseLandingQuery } from './application/use-cases/get-course-landing.query';
import { GetCourseThumbnailQuery } from './application/use-cases/get-course-thumbnail.query';
import { GetLectureArticleQuery } from './application/use-cases/get-lecture-article.query';
import { GetLectureDownloadQuery } from './application/use-cases/get-lecture-download.query';
import { GetLecturePlaylistQuery } from './application/use-cases/get-lecture-playlist.query';
import { KyselyPublicCatalogRepository } from './infrastructure/kysely-public-catalog.repository';
import { RedisPlaybackRateLimiter } from './infrastructure/redis-playback-rate-limiter';
import { AdminRevisionMediaController } from './presentation/admin-revision-media.controller';
import { CoursePreviewController } from './presentation/course-preview.controller';
import { PublicCatalogController } from './presentation/public-catalog.controller';
import { CatalogSettings } from './application/catalog-settings';
import { CourseDetailAssembler } from './application/course-detail.assembler';
import { CourseLocker } from './application/course-locker';
import { CourseOwnership } from './application/course.ownership';
import { CourseReadinessEvaluator } from './application/course-readiness.evaluator';
import { CurriculumReader } from './application/curriculum-reader';
import { CatalogEventPublisher } from './application/ports/catalog-event.publisher';
import { CategoryRepository } from './application/ports/category.repository';
import { CourseLifecycleRepository } from './application/ports/course-lifecycle.repository';
import { CourseRepository } from './application/ports/course.repository';
import { CurriculumRepository } from './application/ports/curriculum.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { UnpublishedChangesDetector } from './application/ports/unpublished-changes.detector';
import { ContentHashUnpublishedChangesDetector } from './application/content-hash-unpublished-changes.detector';
import { IdentityCoursePeopleDirectory } from './application/identity-course-people.directory';
import { CoursePeopleDirectory } from './application/ports/course-people.directory';
import { RevisionRepository } from './application/ports/revision.repository';
import { SubmissionRateLimiter } from './application/ports/submission-rate-limiter';
import { WorkingCopySnapshotter } from './application/working-copy-snapshotter';
import { AdminSearchCoursesQuery } from './application/use-cases/admin-search-courses.query';
import { ApproveRevisionCommand } from './application/use-cases/approve-revision.command';
import { ArchiveCourseCommand } from './application/use-cases/archive-course.command';
import { GetCourseHistoryQuery } from './application/use-cases/get-course-history.query';
import { GetRevisionReviewQuery } from './application/use-cases/get-revision-review.query';
import { ListReviewQueueQuery } from './application/use-cases/list-review-queue.query';
import { RejectRevisionCommand } from './application/use-cases/reject-revision.command';
import { RestoreCourseCommand } from './application/use-cases/restore-course.command';
import { SubmitCourseCommand } from './application/use-cases/submit-course.command';
import { WithdrawSubmissionCommand } from './application/use-cases/withdraw-submission.command';
import { KyselyRevisionRepository } from './infrastructure/kysely-revision.repository';
import { RedisSubmissionRateLimiter } from './infrastructure/redis-submission-rate-limiter';
import { AdminCourseModerationController } from './presentation/admin-course-moderation.controller';
import { CourseLifecycleController } from './presentation/course-lifecycle.controller';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { AdminListCategoriesQuery } from './application/use-cases/admin-list-categories.query';
import { AttachLectureMediaCommand } from './application/use-cases/attach-lecture-media.command';
import { ClearCourseThumbnailCommand } from './application/use-cases/clear-course-thumbnail.command';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { DeleteCategoryCommand } from './application/use-cases/delete-category.command';
import { DeleteCourseCommand } from './application/use-cases/delete-course.command';
import { DeleteLectureCommand } from './application/use-cases/delete-lecture.command';
import { DeleteSectionCommand } from './application/use-cases/delete-section.command';
import { DetachLectureMediaCommand } from './application/use-cases/detach-lecture-media.command';
import { GetArticleQuery } from './application/use-cases/get-article.query';
import { GetCourseQuery } from './application/use-cases/get-course.query';
import { GetCurriculumQuery } from './application/use-cases/get-curriculum.query';
import { ListCategoryTreeQuery } from './application/use-cases/list-category-tree.query';
import { ListMyCoursesQuery } from './application/use-cases/list-my-courses.query';
import { ReorderCategoriesCommand } from './application/use-cases/reorder-categories.command';
import { ReorderCurriculumCommand } from './application/use-cases/reorder-curriculum.command';
import { SaveArticleCommand } from './application/use-cases/save-article.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { UpdateCategoryCommand } from './application/use-cases/update-category.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { UpdateLectureCommand } from './application/use-cases/update-lecture.command';
import { UpdateSectionCommand } from './application/use-cases/update-section.command';
import { KyselyCategoryRepository } from './infrastructure/kysely-category.repository';
import { KyselyCourseLifecycleRepository } from './infrastructure/kysely-course-lifecycle.repository';
import { KyselyCourseRepository } from './infrastructure/kysely-course.repository';
import { KyselyCurriculumRepository } from './infrastructure/kysely-curriculum.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxCatalogEventPublisher } from './infrastructure/outbox-catalog-event.publisher';
import { AdminCategoriesController } from './presentation/admin-categories.controller';
import { CoursesController } from './presentation/courses.controller';
import { CurriculumController } from './presentation/curriculum.controller';
import { InstructorCoursesController } from './presentation/instructor-courses.controller';

/** `CatalogSettings` from the validated env (`CATALOG_*`). */
export function catalogSettingsFrom(config: AppConfigService): CatalogSettings {
  return new CatalogSettings({
    minLectures: config.get('CATALOG_SUBMIT_MIN_LECTURES'),
    minVideoSeconds: config.get('CATALOG_SUBMIT_MIN_VIDEO_SECONDS'),
  });
}

/**
 * catalog (design §3–§8): categories, the course working copy (details, bullets, slug,
 * thumbnail), curriculum, media attachment and deletion (P2-T9, "catalog A"); the lifecycle
 * (submit/withdraw/approve/reject/archive/restore), immutable revisions, history and the admin
 * review queue / revision review / course list (P2-T10, "catalog B"); the public catalog
 * (category tree, browse, landing, thumbnails), playback authorization for the live revision,
 * the working copy and revisions, the HLS playlist / article / download endpoints and the
 * `CatalogFacade` (P2-T11, "catalog C").
 *
 * Depends on media through `MediaFacade` only (usages in catalog's own transaction; playlists
 * and presigned URLs after catalog authorized the viewer), on identity through
 * `IdentityFacade` (names, ban flags), on users through `UsersFacade` (public instructor
 * profiles, null for banned users), on the global `COURSE_ENTITLEMENTS` port (playback of
 * non-preview lectures), plus the global DatabaseModule, OutboxModule, RedisModule,
 * AppConfigModule and AuthSupportModule. `CourseOwnership` is discovered by access's
 * OwnershipRegistry for `@CheckPolicy({ resource: 'course' })`.
 *
 * Exports `CatalogFacade` only (Phase 4/5 seams).
 */
@Module({
  imports: [MediaModule, IdentityModule, UsersModule],
  controllers: [
    PublicCatalogController,
    CoursePreviewController,
    AdminRevisionMediaController,
    InstructorCoursesController,
    CoursesController,
    CurriculumController,
    CourseLifecycleController,
    AdminCategoriesController,
    AdminCourseModerationController,
  ],
  providers: [
    // Configuration
    { provide: CatalogSettings, inject: [AppConfigService], useFactory: catalogSettingsFrom },

    // Persistence and events
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: CourseRepository, useClass: KyselyCourseRepository },
    { provide: CourseLifecycleRepository, useClass: KyselyCourseLifecycleRepository },
    { provide: CurriculumRepository, useClass: KyselyCurriculumRepository },
    { provide: CategoryRepository, useClass: KyselyCategoryRepository },
    { provide: CatalogEventPublisher, useClass: OutboxCatalogEventPublisher },
    { provide: RevisionRepository, useClass: KyselyRevisionRepository },
    { provide: SubmissionRateLimiter, useClass: RedisSubmissionRateLimiter },
    { provide: CoursePeopleDirectory, useClass: IdentityCoursePeopleDirectory },
    // "Unpublished changes" = working-copy content hash != live revision content_hash (§4).
    { provide: UnpublishedChangesDetector, useClass: ContentHashUnpublishedChangesDetector },

    // Application services
    CourseOwnership,
    CourseLocker,
    CurriculumReader,
    CourseReadinessEvaluator,
    CourseDetailAssembler,
    WorkingCopySnapshotter,

    // Use cases: categories
    AdminListCategoriesQuery,
    ListCategoryTreeQuery,
    CreateCategoryCommand,
    UpdateCategoryCommand,
    ReorderCategoriesCommand,
    DeleteCategoryCommand,

    // Use cases: course working copy
    ListMyCoursesQuery,
    CreateCourseCommand,
    GetCourseQuery,
    UpdateCourseCommand,
    SetCourseThumbnailCommand,
    ClearCourseThumbnailCommand,
    DeleteCourseCommand,

    // Use cases: curriculum
    GetCurriculumQuery,
    ReorderCurriculumCommand,
    AddSectionCommand,
    UpdateSectionCommand,
    DeleteSectionCommand,
    AddLectureCommand,
    UpdateLectureCommand,
    DeleteLectureCommand,
    GetArticleQuery,
    SaveArticleCommand,
    AttachLectureMediaCommand,
    DetachLectureMediaCommand,

    // Use cases: lifecycle and moderation (P2-T10)
    SubmitCourseCommand,
    WithdrawSubmissionCommand,
    ApproveRevisionCommand,
    RejectRevisionCommand,
    ArchiveCourseCommand,
    RestoreCourseCommand,
    GetCourseHistoryQuery,
    ListReviewQueueQuery,
    GetRevisionReviewQuery,
    AdminSearchCoursesQuery,

    // Public read and playback (P2-T11)
    { provide: PublicCatalogRepository, useClass: KyselyPublicCatalogRepository },
    { provide: PlaybackRateLimiter, useClass: RedisPlaybackRateLimiter },
    LectureAccessAuthorizer,
    BrowseCoursesQuery,
    GetCourseLandingQuery,
    GetCourseThumbnailQuery,
    GetLecturePlaylistQuery,
    GetLectureArticleQuery,
    GetLectureDownloadQuery,
    CatalogFacade,
  ],
  exports: [CatalogFacade],
})
export class CatalogModule {}
