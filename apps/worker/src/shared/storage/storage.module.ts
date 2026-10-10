import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ObjectStorage, type StorageConfig, validateStorageConfig } from '@udemy/storage';
import { WorkerConfigService } from '../config';

/** Builds the `@udemy/storage` config from the validated worker env (`S3_*`). */
export function storageConfigFromWorkerEnv(config: WorkerConfigService): StorageConfig {
  const endpoint = config.get('S3_ENDPOINT');
  return validateStorageConfig({
    endpoint,
    publicEndpoint: config.get('S3_PUBLIC_ENDPOINT') ?? endpoint,
    region: config.get('S3_REGION'),
    accessKeyId: config.get('S3_ACCESS_KEY'),
    secretAccessKey: config.get('S3_SECRET_KEY'),
    forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
    buckets: {
      uploads: config.get('S3_BUCKET_UPLOADS'),
      media: config.get('S3_BUCKET_MEDIA'),
    },
  });
}

/**
 * Releases the S3 client sockets on shutdown (design §14: apps own the `ObjectStorage` instance
 * and call `destroy()`). Runs in onApplicationShutdown, i.e. after the cleanup job's
 * beforeApplicationShutdown has waited for a run in progress.
 */
@Injectable()
export class ObjectStorageLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorageLifecycle.name);

  constructor(private readonly storage: ObjectStorage) {}

  onApplicationShutdown(): void {
    this.storage.destroy();
    this.logger.log('S3 clients destroyed');
  }
}

/** Global `ObjectStorage` (no Nest module in `@udemy/storage` by design). */
@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [WorkerConfigService],
      useFactory: (config: WorkerConfigService): ObjectStorage =>
        new ObjectStorage(storageConfigFromWorkerEnv(config)),
    },
    ObjectStorageLifecycle,
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
