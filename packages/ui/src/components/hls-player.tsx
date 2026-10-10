'use client';

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  HlsPlaybackController,
  type HlsConstructor,
  type PlayerErrorReason,
  type PlayerStatus,
} from '../lib/hls-playback';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Spinner } from './spinner';

/*
 * HLS video player (design D7, §10). Pass the master playlist URL on this app's BFF, e.g.
 * `/api/proxy/catalog/courses/{courseId}/lectures/{lectureId}/hls/master.m3u8`.
 *
 * - hls.js is imported on mount only (its own chunk), so pages without video never load it.
 *   Native HLS is the fallback when MSE is missing (older iOS).
 * - Segment URLs are presigned for an hour; a 403 reloads the playlists and resumes at the same
 *   position (bounded backoff, see ../lib/hls-playback.ts), then shows an error with a retry.
 * - Native `<video controls>` (accessible, keyboard operable), plus shortcuts while the video
 *   has focus: Space/K play-pause, ←/→ 5 s, J/L 10 s, M mute, F fullscreen.
 * - `children` go inside `<video>`: the slot for `<track kind="captions">` elements.
 * - CSP: needs `media-src blob:`, `worker-src blob:` and `connect-src <media origin>`.
 */

export interface HlsPlayerError {
  reason: PlayerErrorReason;
  httpStatus?: number;
}

export interface HlsPlayerProps extends Omit<
  ComponentProps<'div'>,
  'title' | 'onError' | 'children'
> {
  /** Master playlist URL (same-origin BFF route). */
  src: string;
  /** Poster image URL (e.g. the stable signed-redirect image route). */
  poster?: string;
  /** Accessible name of the video (the lecture title). */
  title: string;
  /** Called once each time the player enters its error state. */
  onError?: (error: HlsPlayerError) => void;
  /** `<track>` elements (captions, later). */
  children?: ReactNode;
  /** Class names of the `<video>` element. */
  videoClassName?: string;
}

export const PLAYER_ERROR_MESSAGES: Readonly<Record<PlayerErrorReason, string>> = {
  forbidden: 'You do not have access to this video.',
  unauthorized: 'Your session has ended. Sign in again to keep watching.',
  'not-found': 'This video is not available.',
  'not-ready': 'This video is still being processed. Try again in a few minutes.',
  expired: 'Playback was interrupted and could not be resumed.',
  network: 'The video could not be loaded. Check your connection and try again.',
  media: 'This video could not be played.',
  unsupported: 'Your browser cannot play this video.',
};

/** Reasons a retry cannot fix; no "Try again" button for those. */
const FINAL_REASONS: ReadonlySet<PlayerErrorReason> = new Set([
  'forbidden',
  'not-found',
  'unsupported',
]);

const SEEK_SMALL_S = 5;
const SEEK_LARGE_S = 10;

async function loadHls(): Promise<HlsConstructor> {
  const mod = await import('hls.js');
  // The controller only uses a narrow, structurally compatible subset of the class.
  return mod.default as unknown as HlsConstructor;
}

function hasMediaSource(): boolean {
  return (
    typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window)
  );
}

function HlsPlayer({
  src,
  poster,
  title,
  onError,
  children,
  className,
  videoClassName,
  ...props
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<HlsPlaybackController | null>(null);
  const [status, setStatus] = useState<PlayerStatus>({ kind: 'idle' });

  const reportError = useEffectEvent((next: PlayerStatus) => {
    if (next.kind === 'error') {
      onError?.(
        next.httpStatus === undefined
          ? { reason: next.reason }
          : { reason: next.reason, httpStatus: next.httpStatus },
      );
    }
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const controller = new HlsPlaybackController({
      media: video,
      src,
      loadHls,
      hasMediaSource,
      onStatus: (next) => {
        setStatus(next);
        reportError(next);
      },
    });
    controllerRef.current = controller;
    void controller.start();
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [src]);

  function onKeyDown(event: KeyboardEvent<HTMLVideoElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const video = event.currentTarget;
    const seek = (delta: number) => {
      const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), end);
    };
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
        break;
      case 'ArrowLeft':
        seek(-SEEK_SMALL_S);
        break;
      case 'ArrowRight':
        seek(SEEK_SMALL_S);
        break;
      case 'j':
      case 'J':
        seek(-SEEK_LARGE_S);
        break;
      case 'l':
      case 'L':
        seek(SEEK_LARGE_S);
        break;
      case 'm':
      case 'M':
        video.muted = !video.muted;
        break;
      case 'f':
      case 'F':
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void video.requestFullscreen?.().catch(() => undefined);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const busy = status.kind === 'loading' || status.kind === 'refreshing';

  return (
    <div
      data-slot="hls-player"
      data-status={status.kind}
      className={cn('relative aspect-video w-full overflow-hidden rounded-lg bg-black', className)}
      {...props}
    >
      <video
        ref={videoRef}
        className={cn('size-full', videoClassName)}
        controls
        playsInline
        preload="metadata"
        poster={poster}
        aria-label={title}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        {children}
      </video>

      {status.kind === 'refreshing' && (
        <div
          role="status"
          className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-white"
        >
          <Spinner className="size-3.5" />
          Reconnecting…
        </div>
      )}

      {status.kind === 'error' && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center text-sm text-white"
        >
          <p className="max-w-sm">{PLAYER_ERROR_MESSAGES[status.reason]}</p>
          {!FINAL_REASONS.has(status.reason) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                controllerRef.current?.retry();
                videoRef.current?.focus();
              }}
            >
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export { HlsPlayer };
