import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ObjectStorage } from '@udemy/storage';
import { storageConfigFromTranscoderEnv, TranscoderConfigService } from '../config';

/** Destroys the S3 clients' sockets after everything else has shut down. */
@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  onApplicationShutdown(): void {
    this.storage.destroy();
  }
}

/** Global `ObjectStorage` (design §14: no Nest module in @udemy/storage; apps provide it). */
@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [TranscoderConfigService],
      useFactory: (config: TranscoderConfigService): ObjectStorage =>
        new ObjectStorage(
          storageConfigFromTranscoderEnv({
            S3_ENDPOINT: config.get('S3_ENDPOINT'),
            S3_PUBLIC_ENDPOINT: config.get('S3_PUBLIC_ENDPOINT'),
            S3_REGION: config.get('S3_REGION'),
            S3_ACCESS_KEY: config.get('S3_ACCESS_KEY'),
            S3_SECRET_KEY: config.get('S3_SECRET_KEY'),
            S3_BUCKET_UPLOADS: config.get('S3_BUCKET_UPLOADS'),
            S3_BUCKET_MEDIA: config.get('S3_BUCKET_MEDIA'),
            S3_FORCE_PATH_STYLE: config.get('S3_FORCE_PATH_STYLE'),
          }),
        ),
    },
    StorageLifecycle,
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
