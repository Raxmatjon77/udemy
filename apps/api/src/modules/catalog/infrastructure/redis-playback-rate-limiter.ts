import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter, type RateLimitRule } from '../../../shared/redis';
import { PlaybackRateLimiter } from '../application/ports/playback-rate-limiter';

/** Design §9: `rl:catalog:playlist:ip:{ip}` 240/min (playlists, articles, downloads). */
export const PLAYBACK_RATE_LIMIT: RateLimitRule = { limit: 240, windowMs: 60_000 };
/** Thumbnail presigns: a browse page shows up to 48 cards, each one redirect. */
export const IMAGE_RATE_LIMIT: RateLimitRule = { limit: 600, windowMs: 60_000 };

export function playbackRateLimitKey(ip: string): string {
  return `rl:catalog:playlist:ip:${ip}`;
}

export function imageRateLimitKey(ip: string): string {
  return `rl:catalog:image:ip:${ip}`;
}

/** Fixed-window Redis counters per end-user IP (as reported by the authenticated BFF). */
@Injectable()
export class RedisPlaybackRateLimiter extends PlaybackRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  hitPlayback(ip: string): Promise<void> {
    return this.hit(playbackRateLimitKey(ip), PLAYBACK_RATE_LIMIT);
  }

  hitImage(ip: string): Promise<void> {
    return this.hit(imageRateLimitKey(ip), IMAGE_RATE_LIMIT);
  }

  private async hit(key: string, rule: RateLimitRule): Promise<void> {
    const result = await this.limiter.hit(key, rule);
    if (result.limited) {
      throw new RateLimitedError('Too many requests. Please try again later.', {
        retryAfterMs: result.ttlMs,
      });
    }
  }
}
