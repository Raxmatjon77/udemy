import { Inject, Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, indicatorResult } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';
import { FfmpegToolchain } from '../ffmpeg/ffmpeg-toolchain.service';

const S3_TIMEOUT_MS = 2_000;

/** HeadBucket on both buckets within 2 s. */
@Injectable()
export class StorageHealthIndicator {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  async check<TKey extends string>(key: TKey): Promise<HealthIndicatorResult<TKey>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), S3_TIMEOUT_MS);
        }),
      ]);
      return indicatorResult(key, 'up');
    } catch {
      return indicatorResult(key, 'down', { message: 'Object storage is unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** ffmpeg and ffprobe still run and report a supported version. */
@Injectable()
export class FfmpegHealthIndicator {
  constructor(private readonly toolchain: FfmpegToolchain) {}

  async check<TKey extends string>(key: TKey): Promise<HealthIndicatorResult<TKey>> {
    const result = await this.toolchain.checkAvailable();
    const versions = this.toolchain.detectedVersions;
    return result.ok
      ? indicatorResult(key, 'up', {
          ffmpeg: versions?.ffmpeg.version,
          ffprobe: versions?.ffprobe.version,
        })
      : indicatorResult(key, 'down', { message: 'ffmpeg/ffprobe unavailable' });
  }
}
