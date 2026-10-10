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
export { sql, Kysely, Transaction } from 'kysely';
