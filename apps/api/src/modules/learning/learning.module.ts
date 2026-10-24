import { type FactoryProvider, Module } from '@nestjs/common';
import { COVERAGE_BUCKET_SECONDS } from '@udemy/db';
import { AppConfigService } from '../../shared/config';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { IdentityModule } from '../identity';
import { UsersModule } from '../users';
import { CertificatePresenter } from './application/certificate.presenter';
import { CompletionRecorder } from './application/completion-recorder';
import { LearnerAccess } from './application/learner-access';
import { LearningFacade } from './application/learning.facade';
import {
  CertificateOwnership,
  NoteOwnership,
  QuizAttemptOwnership,
} from './application/learning.ownership';
import { LearningProgressReader } from './application/learning-progress.reader';
import { LearningSettings } from './application/learning-settings';
import { AccessCache } from './application/ports/access-cache';
import { CertificateEventPublisher } from './application/ports/certificate-event.publisher';
import { CertificatePdfStorage } from './application/ports/certificate-pdf.storage';
import { CertificateRepository } from './application/ports/certificates.repository';
import { LearningClock } from './application/ports/learning-clock';
import { LearningEventPublisher } from './application/ports/learning-event.publisher';
import { LearningRateLimiter } from './application/ports/learning-rate-limiter';
import { LearningRepository } from './application/ports/learning.repository';
import { NotesRepository } from './application/ports/notes.repository';
import { ProgressFlushQueue } from './application/ports/progress-flush-queue';
import { ProgressRepository } from './application/ports/progress.repository';
import { ProgressStore } from './application/ports/progress-store';
import { QuizAttemptRepository } from './application/ports/quiz-attempts.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { ProgressFlushJob } from './application/progress-flush.job';
import { QuizAttemptPresenter } from './application/quiz-attempt.presenter';
import {
  AdminCertificateActionCommand,
  AdminListUserCertificatesQuery,
  GetMyCertificatePdfQuery,
  GetMyCertificateQuery,
  GetPublicCertificatePdfQuery,
  ListMyCertificatesQuery,
  VerifyCertificateQuery,
} from './application/use-cases/certificates.use-cases';
import { CompleteLectureCommand } from './application/use-cases/complete-lecture.command';
import { GetPlayerBootstrapQuery } from './application/use-cases/get-player-bootstrap.query';
import {
  CreateNoteCommand,
  DeleteNoteCommand,
  ListNotesQuery,
  UpdateNoteCommand,
} from './application/use-cases/notes.use-cases';
import {
  GetQuizAttemptQuery,
  ListQuizAttemptsQuery,
  StartQuizAttemptCommand,
  SubmitQuizAttemptCommand,
} from './application/use-cases/quiz-attempts.use-cases';
import { RecordHeartbeatCommand } from './application/use-cases/record-heartbeat.command';
import { UncompleteLectureCommand } from './application/use-cases/uncomplete-lecture.command';
import { DirectProgressStore } from './infrastructure/direct-progress.store';
import { KyselyCertificateRepository } from './infrastructure/kysely-certificates.repository';
import { KyselyLearningRepository } from './infrastructure/kysely-learning.repository';
import { KyselyNotesRepository } from './infrastructure/kysely-notes.repository';
import { KyselyProgressRepository } from './infrastructure/kysely-progress.repository';
import { KyselyQuizAttemptRepository } from './infrastructure/kysely-quiz-attempts.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxCertificateEventPublisher } from './infrastructure/outbox-certificate-event.publisher';
import { OutboxLearningEventPublisher } from './infrastructure/outbox-learning-event.publisher';
import { ProgressFlushScheduler } from './infrastructure/progress-flush.scheduler';
import { RedisAccessCache } from './infrastructure/redis-access-cache';
import { RedisLearningRateLimiter } from './infrastructure/redis-learning-rate-limiter';
import { RedisProgressFlushQueue } from './infrastructure/redis-progress-flush.queue';
import { RedisProgressKeys } from './infrastructure/redis-progress.scripts';
import { RedisProgressStore } from './infrastructure/redis-progress.store';
import { S3CertificatePdfStorage } from './infrastructure/s3-certificate-pdf.storage';
import { SystemLearningClock } from './infrastructure/system-learning-clock';
import {
  AdminCertificatesController,
  MyCertificatesController,
  PublicCertificatesController,
} from './presentation/certificates.controller';
import { LearningNotesController } from './presentation/learning-notes.controller';
import { LearningPlayerController } from './presentation/learning-player.controller';
import { QuizAttemptsController } from './presentation/quiz-attempts.controller';

/**
 * `LearningSettings` from the validated `LEARNING_*` env. The bucket width is part of the
 * stored data (`lecture_progress_coverage_ck` = ceil(duration / 5)), so any other value is
 * refused at boot instead of corrupting coverage.
 */
export function learningSettingsFrom(config: AppConfigService): LearningSettings {
  const bucketSeconds = config.get('LEARNING_COVERAGE_BUCKET_S');
  if (bucketSeconds !== COVERAGE_BUCKET_SECONDS) {
    throw new Error(
      `LEARNING_COVERAGE_BUCKET_S=${bucketSeconds} is not supported: the learning schema stores ` +
        `${COVERAGE_BUCKET_SECONDS} s buckets (lecture_progress_coverage_ck)`,
    );
  }
  return new LearningSettings(
    config.get('LEARNING_PROGRESS_STORE'),
    config.get('LEARNING_JOBS_ENABLED'),
    config.get('LEARNING_PROGRESS_FLUSH_INTERVAL_MS'),
    config.get('LEARNING_PROGRESS_FLUSH_BATCH_SIZE'),
    bucketSeconds,
    config.get('LEARNING_VIDEO_COMPLETE_PCT'),
  );
}

/** `ProgressStore` per `LEARNING_PROGRESS_STORE` (design §12 Q1): Redis write-behind or direct. */
export const PROGRESS_STORE_PROVIDER: FactoryProvider<ProgressStore> = {
  provide: ProgressStore,
  inject: [LearningSettings, RedisProgressStore, DirectProgressStore],
  useFactory: (
    settings: LearningSettings,
    redis: RedisProgressStore,
    direct: DirectProgressStore,
  ): ProgressStore => (settings.progressStore === 'direct' ? direct : redis),
};

/**
 * learning A (Phase 5 learning experience design §3–§9, P5-T10): the player bootstrap, progress
 * heartbeats (Redis write-behind with plausibility, or direct), lecture completion and the
 * permanent course completion (`lrnc` mutex, outbox in the same transaction), the
 * `ProgressFlushJob` (`_06`, every 15 s, final flush on shutdown), `LearningFacade`
 * (consumption for commerce, completed-lecture count for engagement) and the `COURSE_PROGRESS`
 * adapter `LearningProgressReader`.
 *
 * learning B (P5-T11): private notes (`note` lock class for the 500 cap), quiz attempts
 * (start/resume, server-side grading against the attempt revision's key, the reveal policy,
 * `QUIZ_PASSED` completion in the grading transaction) and certificates (own list/detail/PDF,
 * public verification by code, admin revoke/reinstate with cause ADMIN). Certificates are
 * issued, revoked on enrollment changes and rendered by the worker (P5-T15); stale attempts
 * are abandoned by the worker's `LearningMaintenanceJob`.
 *
 * Depends on catalog (`CatalogFacade`: live curriculum, learner-safe quiz views, the grading
 * key), enrollment (`EnrollmentFacade.hasAccess`), identity (`IdentityFacade`: admin user
 * lookups and actor names) and users (`UsersFacade`: the instructor's public profile), plus the
 * global ObjectStorageModule (presigned certificate PDFs), DatabaseModule,
 * RedisModule, OutboxModule, AppConfigModule, ScheduleModule and AuthSupportModule.
 * `LearningProgressReader` itself depends only on its repository and `CatalogFacade` (D21).
 *
 * Exports `LearningFacade` (commerce in P5-T16; AppModule binds it to `LECTURE_COMPLETIONS`) and
 * `LearningProgressReader` (AppModule only: `COURSE_PROGRESS`).
 */
@Module({
  imports: [CatalogModule, EnrollmentModule, IdentityModule, UsersModule],
  controllers: [
    LearningPlayerController,
    LearningNotesController,
    QuizAttemptsController,
    MyCertificatesController,
    PublicCertificatesController,
    AdminCertificatesController,
  ],
  providers: [
    // Configuration, clock, persistence, events, limits, caches
    { provide: LearningSettings, inject: [AppConfigService], useFactory: learningSettingsFrom },
    { provide: LearningClock, useClass: SystemLearningClock },
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: LearningRepository, useClass: KyselyLearningRepository },
    { provide: ProgressRepository, useClass: KyselyProgressRepository },
    { provide: LearningEventPublisher, useClass: OutboxLearningEventPublisher },
    { provide: LearningRateLimiter, useClass: RedisLearningRateLimiter },
    { provide: AccessCache, useClass: RedisAccessCache },
    { provide: NotesRepository, useClass: KyselyNotesRepository },
    { provide: QuizAttemptRepository, useClass: KyselyQuizAttemptRepository },
    { provide: CertificateRepository, useClass: KyselyCertificateRepository },
    { provide: CertificateEventPublisher, useClass: OutboxCertificateEventPublisher },
    { provide: CertificatePdfStorage, useClass: S3CertificatePdfStorage },

    // Progress buffer: both stores exist, the env picks one; the flush always drains Redis
    // (so switching to `direct` still flushes what was buffered before).
    { provide: RedisProgressKeys, useValue: new RedisProgressKeys() },
    RedisProgressStore,
    DirectProgressStore,
    PROGRESS_STORE_PROVIDER,
    { provide: ProgressFlushQueue, useClass: RedisProgressFlushQueue },
    ProgressFlushJob,
    ProgressFlushScheduler,

    // Application services and the public seams
    LearnerAccess,
    CompletionRecorder,
    LearningFacade,
    LearningProgressReader,

    // Use cases
    GetPlayerBootstrapQuery,
    RecordHeartbeatCommand,
    CompleteLectureCommand,
    UncompleteLectureCommand,

    // learning B (P5-T11): notes, quiz attempts, certificates, and their ownership resolvers
    NoteOwnership,
    QuizAttemptOwnership,
    CertificateOwnership,
    QuizAttemptPresenter,
    CertificatePresenter,
    ListNotesQuery,
    CreateNoteCommand,
    UpdateNoteCommand,
    DeleteNoteCommand,
    StartQuizAttemptCommand,
    ListQuizAttemptsQuery,
    GetQuizAttemptQuery,
    SubmitQuizAttemptCommand,
    ListMyCertificatesQuery,
    GetMyCertificateQuery,
    GetMyCertificatePdfQuery,
    VerifyCertificateQuery,
    GetPublicCertificatePdfQuery,
    AdminListUserCertificatesQuery,
    AdminCertificateActionCommand,
  ],
  exports: [LearningFacade, LearningProgressReader],
})
export class LearningModule {}
