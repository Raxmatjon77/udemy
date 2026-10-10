/**
 * Per-IP limits on the public playback and image routes (design §9: presigning is cheap for
 * us but every signed URL is a bearer capability, so mass minting is throttled):
 *
 * - `rl:catalog:playlist:ip:{ip}`: HLS playlists, public articles and downloads (240/min).
 * - `rl:catalog:image:ip:{ip}`: thumbnail presigns (600/min; a browse page shows up to 48).
 *
 * Each call counts one hit and throws `RateLimitedError` (429 `rate_limited`, Retry-After)
 * once the window is exhausted. Fails closed: an unreachable Redis is a 503.
 */
export abstract class PlaybackRateLimiter {
  abstract hitPlayback(ip: string): Promise<void>;
  abstract hitImage(ip: string): Promise<void>;
}
