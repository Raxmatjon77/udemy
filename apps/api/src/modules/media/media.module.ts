import { Module } from '@nestjs/common';
import { AppConfigService } from '../../shared/config';
import { AccessModule } from '../access';
import { MediaAssetOwnership } from './application/media-asset.ownership';
import { MediaPlaybackService } from './application/media-playback.service';
import { MediaSettings } from './application/media-settings';
import { MediaFacade } from './application/media.facade';
import { PlaylistCache } from './application/playlist-cache';
import { AssetUsageRepository } from './application/ports/asset-usage.repository';
import { MediaAssetRepository } from './application/ports/media-asset.repository';
import { MediaEventPublisher } from './application/ports/media-event.publisher';
import { MediaObjectStore } from './application/ports/media-object.store';
import { TransactionRunner } from './application/ports/transaction-runner';
import { UploadRateLimiter } from './application/ports/upload-rate-limiter';
import { AbortUploadCommand } from './application/use-cases/abort-upload.command';
import { CompleteUploadCommand } from './application/use-cases/complete-upload.command';
import { GetAssetQuery } from './application/use-cases/get-asset.query';
import { GetUploadStatusQuery } from './application/use-cases/get-upload-status.query';
import { InitiateUploadCommand } from './application/use-cases/initiate-upload.command';
import { ListAssetsQuery } from './application/use-cases/list-assets.query';
import { PresignPartsCommand } from './application/use-cases/presign-parts.command';
import { KyselyAssetUsageRepository } from './infrastructure/kysely-asset-usage.repository';
import { KyselyMediaAssetRepository } from './infrastructure/kysely-media-asset.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxMediaEventPublisher } from './infrastructure/outbox-media-event.publisher';
import { RedisUploadRateLimiter } from './infrastructure/redis-upload-rate-limiter';
import { S3MediaObjectStore } from './infrastructure/s3-media-object.store';
import { MediaAssetsController } from './presentation/media-assets.controller';
import { MediaUploadsController } from './presentation/media-uploads.controller';

/** `MediaSettings` from the validated env (`MEDIA_*`). */
export function mediaSettingsFrom(config: AppConfigService): MediaSettings {
  return new MediaSettings({
    partUrlTtlSeconds: config.get('MEDIA_PART_URL_TTL_S'),
    playbackUrlTtlSeconds: config.get('MEDIA_PLAYBACK_URL_TTL_S'),
    imageUrlTtlSeconds: config.get('MEDIA_IMAGE_URL_TTL_S'),
    downloadUrlTtlSeconds: config.get('MEDIA_DOWNLOAD_URL_TTL_S'),
    maxBytes: {
      LECTURE_VIDEO: config.get('MEDIA_MAX_VIDEO_BYTES'),
      COURSE_THUMBNAIL: config.get('MEDIA_MAX_IMAGE_BYTES'),
      LECTURE_RESOURCE: config.get('MEDIA_MAX_RESOURCE_BYTES'),
    },
    quota: {
      quotaBytes: config.get('MEDIA_QUOTA_BYTES_PER_OWNER'),
      maxConcurrentUploads: config.get('MEDIA_MAX_CONCURRENT_UPLOADS'),
    },
  });
}

/**
 * media: uploads, assets, usages, playlists and signed URLs (design §3–§8). Depends only on
 * shared infrastructure (global DatabaseModule, RedisModule, OutboxModule, ObjectStorageModule,
 * AuthSupportModule) and the access facade (Authorizer for the "own OR any" listing).
 *
 * Exports `MediaFacade` (catalog, P2-T9..T11). `MediaAssetOwnership` is discovered by access's
 * OwnershipRegistry for `@CheckPolicy({ resource: 'media_asset' })`.
 */
@Module({
  imports: [AccessModule],
  controllers: [MediaUploadsController, MediaAssetsController],
  providers: [
    // Configuration
    { provide: MediaSettings, inject: [AppConfigService], useFactory: mediaSettingsFrom },
    { provide: PlaylistCache, useFactory: (): PlaylistCache => new PlaylistCache() },

    // Persistence, storage, events, limits
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: MediaAssetRepository, useClass: KyselyMediaAssetRepository },
    { provide: AssetUsageRepository, useClass: KyselyAssetUsageRepository },
    { provide: MediaObjectStore, useClass: S3MediaObjectStore },
    { provide: MediaEventPublisher, useClass: OutboxMediaEventPublisher },
    { provide: UploadRateLimiter, useClass: RedisUploadRateLimiter },

    // Application services
    MediaAssetOwnership,
    MediaPlaybackService,
    MediaFacade,

    // Use cases
    InitiateUploadCommand,
    GetUploadStatusQuery,
    PresignPartsCommand,
    CompleteUploadCommand,
    AbortUploadCommand,
    GetAssetQuery,
    ListAssetsQuery,
  ],
  exports: [MediaFacade],
})
export class MediaModule {}
