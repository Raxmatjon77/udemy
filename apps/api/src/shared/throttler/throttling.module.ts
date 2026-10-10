import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClientIpResolver } from '../auth/client-ip.resolver';
import { AppConfigService } from '../config/app-config.service';

/** Name of the single global throttler (keys look like `global:<ip>`). */
export const GLOBAL_THROTTLER = 'global';

/**
 * Global per-client-IP rate limit (design §9: 300 req/min by default; THROTTLE_LIMIT /
 * THROTTLE_TTL_MS). Opt out per route with @SkipThrottle, tune with @Throttle.
 *
 * - Tracker: the trusted end-user IP from ClientIpResolver, i.e. the BFF's `X-Client-IP` once
 *   ClientAuthGuard (global guard #1) has authenticated the BFF, else `req.ip`. Without this
 *   every user behind one BFF would share the BFF's bucket.
 * - Key: one bucket per IP across all routes (the library default is one per route).
 *
 * The guard is NOT registered here: AppModule registers every APP_GUARD in one place, in the
 * order ClientAuthGuard -> ThrottlerGuard -> JwtAuthGuard -> PoliciesGuard, and uses the
 * ThrottlerGuard exported by this module (`useExisting`).
 *
 * TODO(phase 1+): Redis storage, so the limit is shared across replicas (today: in-memory,
 * per pod). `@nest-lab/throttler-storage-redis@1.2.0` (latest) declares peer
 * `@nestjs/common` / `@nestjs/core` only up to ^11, not Nest 12, so it is not used. When a
 * version supporting Nest 12 ships (or with a small own `ThrottlerStorage` on the REDIS client
 * using the RateLimiter Lua script), set `storage` below. The security-critical limits (login,
 * signup) already use Redis through RateLimiter.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, ClientIpResolver],
      useFactory: (config: AppConfigService, ips: ClientIpResolver) => ({
        throttlers: [
          {
            name: GLOBAL_THROTTLER,
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_LIMIT'),
          },
        ],
        getTracker: (req: Record<string, unknown>): string =>
          ips.resolve(req as unknown as Request),
        generateKey: (_ctx, tracker: string, throttlerName: string): string =>
          `${throttlerName}:${tracker}`,
      }),
    }),
  ],
  providers: [ThrottlerGuard],
  exports: [ThrottlerGuard],
})
export class ThrottlingModule {}
