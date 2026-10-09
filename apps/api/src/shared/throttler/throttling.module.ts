import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigService } from '../config/app-config.service';

/**
 * Global per-IP rate limit (opt out per route with @SkipThrottle, tune with @Throttle).
 * TODO(phase 1): use Redis storage (e.g. @nest-lab/throttler-storage-redis) so limits are
 * shared across replicas; the default in-memory storage is per pod.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ ttl: config.get('THROTTLE_TTL_MS'), limit: config.get('THROTTLE_LIMIT') }],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class ThrottlingModule {}
