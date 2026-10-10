export type { BucketRole, StorageConfig, StorageEnv } from './config';
export { storageConfigFromEnv, validateStorageConfig } from './config';
export { attachmentContentDisposition } from './content-disposition';
export type { StorageErrorCode, StorageErrorContext, StorageErrorDetails } from './errors';
export {
  StorageAccessDeniedError,
  StorageConfigError,
  StorageEntityTooLargeError,
  StorageError,
  StorageInvalidRequestError,
  StorageNotFoundError,
  StoragePreconditionFailedError,
  StorageSignatureMismatchError,
  StorageUnavailableError,
  StorageUsageError,
  toStorageError,
} from './errors';
export type { ImageVariant } from './keys';
export {
  ASSETS_PREFIX,
  assertRenditionName,
  assetOutputPrefix,
  assetPrefix,
  HLS_SEGMENT_FILENAME_PATTERN,
  HLS_VARIANT_PLAYLIST_FILENAME,
  hlsSegmentKey,
  hlsVariantPlaylistKey,
  hlsVariantPrefix,
  imageKey,
  parseAssetOutputPrefix,
  parseUploadSourceKey,
  RENDITION_NAME_PATTERN,
  resolvePlaylistUri,
  resourceKey,
  SOURCE_OBJECT_NAME,
  spriteImageKey,
  spriteVttKey,
  UPLOADS_PREFIX,
  uploadSourceKey,
} from './keys';
export type {
  DeleteObjectsResult,
  ListedPart,
  MultipartRef,
  MultipartUploadInfo,
  ObjectInfo,
  ObjectRef,
  ObjectSummary,
  PresignedUploadPart,
  PresignedUrl,
  PresignGetOptions,
  WriteOptions,
} from './object-storage';
export {
  DEFAULT_MAX_TEXT_BYTES,
  DELETE_BATCH_SIZE,
  MAX_PRESIGN_TTL_SECONDS,
  ObjectStorage,
} from './object-storage';
export type {
  PartCheck,
  PartPlan,
  PartRange,
  PlanPartsOptions,
  UploadedPartSize,
} from './part-plan';
export {
  assertValidPartPlan,
  checkUploadedParts,
  DEFAULT_MIN_PART_SIZE,
  DEFAULT_TARGET_MAX_PARTS,
  GiB,
  KiB,
  MiB,
  partRange,
  plannedParts,
  planParts,
  S3_MAX_OBJECT_SIZE,
  S3_MAX_PART_SIZE,
  S3_MAX_PARTS,
  S3_MIN_PART_SIZE,
  TiB,
} from './part-plan';
export type { S3Clients } from './s3-clients';
export {
  createS3Clients,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  destroyS3Clients,
} from './s3-clients';
