export { createDatabase, type CreateDatabaseOptions } from './database';
export type { DB } from './generated/db';
export { type Executor, withTransaction, inTransaction } from './transaction';
export { insertOutboxEvent, type OutboxEventInput } from './outbox';
export { migrateToLatest, migrateDown } from './migrator';
export {
  type CleanupBatchOptions,
  type SessionCleanupResult,
  deleteConsumedRefreshTokens,
  deleteExpiredSessions,
  deleteExpiredOneTimeTokens,
  purgeSecurityEvents,
} from './maintenance/cleanup';
// Phase 2 operational SQL (docs/phase-2-schema-design.md §8)
export {
  TRANSCODE_ERROR_CODES,
  type TranscodeErrorCode,
  TranscodeLeaseLostError,
  type LeaseFence,
  type LeaseOptions,
  type LeaseResult,
  type LeasedAssetInfo,
  type RenditionInput,
  type CompleteInput,
  type CompletedAsset,
  type FailInput,
  type FailResult,
  type FailedAssetInfo,
  type ReapedLease,
  type EnqueueTranscodeJobInput,
  MAX_TRANSCODE_ATTEMPTS_LIMIT,
  transcodeOutputPrefix,
  enqueueTranscodeJob,
  leaseTranscodeJob,
  heartbeatTranscodeJob,
  completeTranscodeJob,
  failTranscodeJob,
  releaseTranscodeJob,
  reapExpiredTranscodeLeases,
} from './media/transcoder';
export {
  type AbortedUpload,
  type PurgedAsset,
  type PurgeOptions,
  type AssetObjectsToDelete,
  type SourceToDelete,
  abortStaleUploads,
  findLiveUploadIds,
  purgeUnusedAssets,
  markAssetObjectsDeleted,
  findAssetsPendingObjectDeletion,
  findExpiredReadySources,
  findStaleFailedSources,
  markSourcesDeleted,
} from './media/cleanup';
export { MEDIA_QUOTA_LOCK_CLASS, type OwnerMediaUsage, lockOwnerMediaUsage } from './media/quota';
export {
  ASSET_CONSUMER_TYPES,
  type AssetConsumerType,
  type AssetUsageKey,
  type LockedAsset,
  lockAssets,
  insertAssetUsage,
  deleteAssetUsage,
  releaseConsumerUsages,
} from './media/usages';
export {
  type TransitionHead,
  type ReviewQueueItem,
  type BrowseCursor,
  type BrowseOptions,
  type BrowseItem,
  getTransitionHead,
  listReviewQueue,
  browsePublishedCourses,
  escapeLikePattern,
} from './catalog/queries';
export {
  type LectureWithoutUsage,
  type LeakedUsage,
  findLecturesWithoutUsage,
  findLeakedUsages,
} from './catalog/consistency';
// Phase 4 operational SQL (docs/phase-4-schema-design.md §8). All at READ COMMITTED.
export {
  REFUND_DISPATCH_LOCK_KEY,
  COMMERCE_RECONCILE_LOCK_KEY,
  type LockedOrder,
  tryAdvisoryXactLock,
  lockUserCart,
  lockOrder,
  findOrderOwner,
} from './commerce/locks';
export {
  type QuoteLine,
  type CouponState,
  type CouponCandidate,
  type CartQuote,
  quoteCart,
  lockCheckoutCoupons,
} from './commerce/quote';
export {
  type ReserveCouponInput,
  reserveCouponRedemption,
  consumeCouponRedemptions,
  releaseCouponRedemptions,
} from './commerce/coupons';
export {
  PROVIDER_EVENT_OUTCOMES,
  type ProviderEventOutcome,
  type ClaimProviderEventInput,
  type FinishProviderEventInput,
  claimProviderEvent,
  finishProviderEvent,
} from './commerce/provider-events';
export {
  type OrderStatus,
  type OrderTransitionCause,
  type AppendOrderTransitionInput,
  type PaidOrderLine,
  type MarkOrderPaidInput,
  type MarkOrderPaidResult,
  appendOrderTransition,
  markOrderPaid,
} from './commerce/orders';
export {
  type LeasedRefund,
  type LeaseRefundsOptions,
  type LeaseRefundsResult,
  type RefundFence,
  type RefundDispatchResult,
  leaseRefundsForDispatch,
  completeRefundDispatch,
  failRefundDispatch,
  releaseRefundDispatchLease,
  applySucceededRefundsToOrder,
} from './commerce/refunds';
export {
  type StaleCreatingPayment,
  type OverdueOpenSession,
  findStaleCreatingPayments,
  findOverdueOpenSessions,
} from './commerce/reconcile';
export {
  MAX_SALES_RANGE_DAYS,
  type SalesSummaryRow,
  type SalesSummary,
  type RecentSaleCursor,
  type RecentSale,
  getInstructorSalesSummary,
  listRecentSales,
} from './commerce/sales';
export {
  type EnrollmentSource,
  type RevokeReason,
  type GrantEnrollmentInput,
  type GrantOutcome,
  type GrantEnrollmentResult,
  type RevokeEnrollmentInput,
  type RevokeOutcome,
  type RevokeEnrollmentResult,
  grantEnrollment,
  revokeEnrollment,
} from './enrollment/enrollments';
export {
  findOrderEnrollmentsWithoutPaidLine,
  findActiveEnrollmentsWithLiveRefund,
} from './enrollment/consistency';
export {
  type LedgerAccountType,
  type PostOutcome,
  type PostResult,
  type PostSaleInput,
  type PostRefundInput,
  type LedgerScope,
  type LedgerDifference,
  type LedgerTotals,
  ensureLedgerAccount,
  postSaleEntry,
  postRefundEntry,
  reconcileLedger,
  getLedgerTotals,
} from './payouts/ledger';
export { listActiveEnrolleesAfter } from './enrollment/enrollees';
// Phase 5 operational SQL (docs/phase-5-schema-design.md §8, §10). All at READ COMMITTED.
export {
  LEARNING_PROGRESS_FLUSH_LOCK_KEY,
  LEARNING_MAINTENANCE_LOCK_KEY,
  LEARNING_COMPLETION_LOCK_CLASS,
  NOTES_CAP_LOCK_CLASS,
  lockLearningCompletion,
  lockNotesCap,
} from './learning/locks';
export {
  COVERAGE_BUCKET_SECONDS,
  MAX_PROGRESS_DURATION_SECONDS,
  coverageBucketCount,
  coverageHexLiteral,
  coverageTextToBytes,
  countCoveredBuckets,
} from './learning/coverage';
export {
  MAX_PROGRESS_BATCH,
  type LectureProgressInput,
  type LectureProgressState,
  type CourseActivityInput,
  type StoredLectureProgress,
  type LectureCoverage,
  upsertLectureProgress,
  upsertCourseActivity,
  listCourseLectureProgress,
  getLectureCoverage,
  getCourseActivity,
} from './learning/progress';
export {
  LECTURE_TYPES,
  type LectureType,
  LECTURE_COMPLETION_CAUSES,
  type LectureCompletionCause,
  COMPLETION_CAUSES_BY_TYPE,
  MAX_LIVE_LECTURES,
  type LectureCompletionInput,
  type LiveLectureSet,
  type CourseCompletionState,
  type RecordCompletionResult,
  type CourseProgressCount,
  insertLectureCompletion,
  evaluateCourseCompletion,
  recordLectureCompletion,
  clearLectureCompletion,
  listCompletedLectureIds,
  getCourseProgressCounts,
} from './learning/completion';
export {
  type LiveLecture,
  type LearningConsumption,
  getLearningConsumption,
  consumptionReviewReason,
} from './learning/consumption';
export {
  CERTIFICATE_PUBLIC_CODE_PATTERN,
  type IssueCertificateInput,
  type IssueCertificateResult,
  type CertificateTransitionInput,
  type CertificateTransitionResult,
  certificatePdfObjectKey,
  issueCertificate,
  recordCertificatePdf,
  transitionCertificate,
  findCertificateId,
} from './learning/certificates';
export { abandonStaleQuizAttempts, findCertificatesPendingPdf } from './learning/maintenance';
export { findCertificateEnrollmentDrift, findMalformedCoverage } from './learning/consistency';
export {
  ANNOUNCEMENT_QUOTA_LOCK_CLASS,
  WISHLIST_CAP_LOCK_CLASS,
  lockAnnouncementQuota,
  lockWishlistCap,
} from './engagement/locks';
export {
  type ReviewUpsertOutcome,
  type UpsertReviewResult,
  type CourseRating,
  upsertReview,
  upsertReviewReply,
  recomputeCourseRating,
  getCourseRatings,
} from './engagement/reviews';
export {
  QA_SORTS,
  type QaSort,
  QA_SEARCH_MIN_CHARS,
  type QuestionCursor,
  type QuestionListItem,
  type ListQuestionsOptions,
  VOTE_SUBJECTS,
  type VoteSubject,
  listQuestions,
  castVote,
  retractVote,
  findMyVotes,
} from './engagement/qa';
export {
  MODERATED_SUBJECT_TYPES,
  type ModeratedSubjectType,
  REPORT_REASONS,
  type ReportReason,
  type ReportContentInput,
  type ReportContentResult,
  type ModerateSubjectInput,
  type ModerateSubjectResult,
  reportContent,
  moderateSubject,
} from './engagement/moderation';
export {
  findRatingStatsDrift,
  findQuestionCounterDrift,
  findAnswerCounterDrift,
  findReviewSuspensionDrift,
} from './engagement/consistency';
export {
  FANOUT_LEASE_MS,
  FANOUT_BATCH_SIZE,
  MAX_FANOUT_ATTEMPTS_LIMIT,
  type FanoutFence,
  type EnqueueAnnouncementFanoutInput,
  type LeasedFanoutJob,
  type AnnouncementNotificationsInput,
  type ReapedFanoutLease,
  enqueueAnnouncementFanout,
  leaseFanoutJob,
  lockFanoutBatch,
  insertAnnouncementNotifications,
  advanceFanoutJob,
  failFanoutAttempt,
  reapExpiredFanoutLeases,
} from './notifications/fanout';
export {
  NOTIFICATION_RETENTION_LOCK_KEY,
  NOTIFICATION_RETENTION_DAYS,
  FANOUT_JOB_RETENTION_DAYS,
  deleteExpiredNotifications,
  deleteFinishedFanoutJobs,
} from './notifications/retention';
export { sql, Kysely, Transaction } from 'kysely';
