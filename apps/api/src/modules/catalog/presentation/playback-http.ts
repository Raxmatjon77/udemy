import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { HLS_PLAYLIST_CONTENT_TYPE } from '@udemy/contracts';
import type { Request, Response } from 'express';
import { getPrincipal, type Principal } from '../../../shared/auth';
import type { PlaybackViewer } from '../domain/playback-access';

/**
 * The playback viewer of a request: the optional principal of a `@Public` route (JwtAuthGuard
 * sets it for a valid Bearer of the calling BFF's app, design finding 5), or the required one
 * of an authenticated route. `isModerator` = `course:read:any`, which only the admin app has.
 */
export const PlaybackViewerParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlaybackViewer | null =>
    toPlaybackViewer(getPrincipal(ctx.switchToHttp().getRequest<Request>())),
);

export function toPlaybackViewer(principal: Principal | undefined): PlaybackViewer | null {
  if (principal === undefined) return null;
  return {
    userId: principal.userId,
    isModerator: principal.permissions.has('course:read:any'),
  };
}

/**
 * Cache policies (design D7, §8): a variant playlist embeds presigned URLs (bearer
 * capabilities with a 1 h TTL), so it is never stored. A master only names relative variant
 * playlists, and for a revision (immutable snapshot) it can be reused briefly by the same
 * browser; the working copy can swap its video at any time, so its master is not cached.
 */
export const PLAYLIST_NO_STORE = 'private, no-store';
export const MASTER_PLAYLIST_SHORT_CACHE = 'private, max-age=60';

/** Writes playlist headers and returns the body for Nest to send. */
export function sendPlaylist(res: Response, body: string, cacheControl: string): string {
  res.setHeader('Content-Type', HLS_PLAYLIST_CONTENT_TYPE);
  res.setHeader('Cache-Control', cacheControl);
  // A playlist is never a document: no MIME sniffing, no framing, no referrer to MinIO.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return body;
}

/** Signed URLs (thumbnail, download) are bearer capabilities: never cache the JSON. */
export function noStore(res: Response): void {
  res.setHeader('Cache-Control', PLAYLIST_NO_STORE);
}

/** OpenAPI content of a playlist response. */
export const PLAYLIST_RESPONSE_CONTENT = {
  [HLS_PLAYLIST_CONTENT_TYPE]: { schema: { type: 'string' as const } },
};
