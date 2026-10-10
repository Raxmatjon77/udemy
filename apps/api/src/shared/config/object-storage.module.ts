import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ObjectStorage, type StorageEnv, storageConfigFromEnv } from '@udemy/storage';
import { AppConfigService } from './app-config.service';

/**
 * The validated `S3_*` env in the shape `storageConfigFromEnv` reads. The api's zod schema has
 * already checked and defaulted every value, so the storage package sees exactly what was
 * validated at boot (not whatever `process.env` holds later).
 */
export function storageEnvFrom(config: AppConfigService): StorageEnv {
  return {
    S3_ENDPOINT: config.get('S3_ENDPOINT'),
    S3_PUBLIC_ENDPOINT: config.get('S3_PUBLIC_ENDPOINT'),
    S3_REGION: config.get('S3_REGION'),
    S3_ACCESS_KEY: config.get('S3_ACCESS_KEY'),
    S3_SECRET_KEY: config.get('S3_SECRET_KEY'),
    S3_BUCKET_UPLOADS: config.get('S3_BUCKET_UPLOADS'),
    S3_BUCKET_MEDIA: config.get('S3_BUCKET_MEDIA'),
    S3_FORCE_PATH_STYLE: String(config.get('S3_FORCE_PATH_STYLE')),
  };
}

/** Releases the S3 clients' sockets on shutdown (needs `app.enableShutdownHooks()`). */
@Injectable()
export class ObjectStorageLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorageLifecycle.name);

  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  onApplicationShutdown(): void {
    this.storage.destroy();
    this.logger.log('Object storage clients destroyed');
  }
}

/**
 * The single `ObjectStorage` (S3/MinIO) of the api process (design §3, §14: no Nest module in
 * `@udemy/storage`; apps provide it and destroy it on shutdown). Global, because both the media
 * module and the readiness probe use it. Creating it does not touch the network, so boot does
 * not fail while MinIO is down: `/api/health/ready` answers 503 and S3 calls fail with 503.
 */
@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): ObjectStorage =>
        new ObjectStorage(storageConfigFromEnv(storageEnvFrom(config))),
    },
    ObjectStorageLifecycle,
  ],
  exports: [ObjectStorage],
})
export class ObjectStorageModule {}
