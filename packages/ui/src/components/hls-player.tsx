'use client';

import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import {
  HlsPlaybackController,
  type HlsConstructor,
  type PlayerErrorReason,
  type PlayerStatus,
} from '../lib/hls-playback';
import { PlayedRangeTracker, type PlayedRangeSeconds } from '../lib/played-ranges';
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
 *
 * Learning progress (Phase 5 design D3, §10): `startPosition` resumes playback, the player
 * tracks what was actually PLAYED (seeks never count) and reports it through `onPlayedRanges`
 * at natural boundaries (pause, seek, end); a heartbeat collects the rest with the imperative
 * `flushPlayedRanges()` (interval, tab hidden, pagehide). `seek()` moves without counting.
 */

export interface HlsPlayerError {
  reason: PlayerErrorReason;
  httpStatus?: number;
  /** The stable problem `code` of a refused master playlist (e.g. `rate_limited`), if known. */
  code?: string;
  /** `Retry-After` of a refused master playlist, in seconds. */
  retryAfterSeconds?: number;
}

export type { PlayedRangeSeconds };

/** Why a played-ranges report was made. */
export type PlayedRangesReason = 'pause' | 'seek' | 'ended' | 'flush';

export interface PlayedRangesReport {
  reason: PlayedRangesReason;
  /** The playback position when the report was made, in seconds. */
  positionSeconds: number;
  /** Media duration in seconds, or null while unknown. */
  durationSeconds: number | null;
  /** What was played since the previous report, merged (fractional seconds); may be empty. */
  ranges: PlayedRangeSeconds[];
}

/** Imperative API (`ref`). */
export interface HlsPlayerHandle {
  /** Moves the playhead (a note's timestamp); does not count as watched. */
  seek(seconds: number): void;
  /** The current playback position in seconds. */
  currentTime(): number;
  /** Reports and clears what was played since the previous report (reason `flush`). */
  flushPlayedRanges(): PlayedRangesReport;
  /** Whether the media is playing right now. */
  isPlaying(): boolean;
}

export interface HlsPlayerProps extends Omit<
  ComponentProps<'div'>,
  'title' | 'onError' | 'children' | 'ref'
> {
  /** Master playlist URL (same-origin BFF route). */
  src: string;
  /** Poster image URL (e.g. the stable signed-redirect image route). */
  poster?: string;
  /** Accessible name of the video (the lecture title). */
  title: string;
  /** Called once each time the player enters its error state. */
  onError?: (error: HlsPlayerError) => void;
  /** Resume position in seconds for the first load (later reloads keep the live position). */
  startPosition?: number;
  /** Played ranges at natural boundaries: pause, seek, end (see `HlsPlayerHandle.flushPlayedRanges`). */
  onPlayedRanges?: (report: PlayedRangesReport) => void;
  /** Playback started or stopped (play/playing vs pause/ended/waiting). */
  onPlayingChange?: (playing: boolean) => void;
  /** The video reached its end. */
  onEnded?: () => void;
  /** Imperative handle: seek, current time, flush played ranges. */
  ref?: Ref<HlsPlayerHandle>;
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

function mediaDuration(video: HTMLVideoElement | null): number | null {
  return video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

function HlsPlayer({
  src,
  poster,
  title,
  onError,
  startPosition,
  onPlayedRanges,
  onPlayingChange,
  onEnded,
  ref,
  children,
  className,
  videoClassName,
  ...props
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<HlsPlaybackController | null>(null);
  const [tracker] = useState(() => new PlayedRangeTracker());
  const [status, setStatus] = useState<PlayerStatus>({ kind: 'idle' });

  const reportError = useEffectEvent((next: PlayerStatus) => {
    if (next.kind === 'error') {
      const error: HlsPlayerError = { reason: next.reason };
      if (next.httpStatus !== undefined) error.httpStatus = next.httpStatus;
      if (next.code !== undefined) error.code = next.code;
      if (next.retryAfterSeconds !== undefined) error.retryAfterSeconds = next.retryAfterSeconds;
      onError?.(error);
    }
  });

  /** Builds a report from the tracker (clears it). */
  const takeReport = (reason: PlayedRangesReport['reason']): PlayedRangesReport => {
    const video = videoRef.current;
    const ranges = tracker.take();
    const position =
      video && Number.isFinite(video.currentTime) ? video.currentTime : tracker.position;
    return {
      reason,
      positionSeconds: position,
      durationSeconds: mediaDuration(video),
      ranges,
    };
  };

  const report = useEffectEvent((reason: Exclude<PlayedRangesReport['reason'], 'flush'>) => {
    onPlayedRanges?.(takeReport(reason));
  });
  const playingChanged = useEffectEvent((playing: boolean) => onPlayingChange?.(playing));
  const ended = useEffectEvent(() => onEnded?.());

  useImperativeHandle(
    ref,
    () => ({
      seek(seconds: number) {
        const video = videoRef.current;
        if (!video || !Number.isFinite(seconds)) return;
        const end = mediaDuration(video) ?? Number.POSITIVE_INFINITY;
        const target = Math.min(Math.max(0, seconds), end);
        tracker.jumpTo(target);
        video.currentTime = target;
      },
      currentTime() {
        const video = videoRef.current;
        return video && Number.isFinite(video.currentTime) ? video.currentTime : tracker.position;
      },
      flushPlayedRanges() {
        return takeReport('flush');
      },
      isPlaying() {
        const video = videoRef.current;
        return !!video && !video.paused && !video.ended;
      },
    }),
    // takeReport only reads refs and the stable tracker
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracker],
  );

  // Played-range tracking from the media events (the controller does not care about them).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      if (!video.paused && !video.seeking) tracker.observe(video.currentTime);
    };
    const onPlaying = () => {
      tracker.observe(video.currentTime);
      playingChanged(true);
    };
    const onPause = () => {
      tracker.cut(video.currentTime);
      playingChanged(false);
      if (!video.ended) report('pause');
    };
    const onSeeking = () => tracker.cut();
    const onSeeked = () => {
      tracker.jumpTo(video.currentTime);
      report('seek');
    };
    const onWaiting = () => tracker.cut();
    const onEndedEvent = () => {
      tracker.cut(video.currentTime);
      playingChanged(false);
      report('ended');
      ended();
    };
    const listeners: Array<[string, () => void]> = [
      ['timeupdate', onTimeUpdate],
      ['playing', onPlaying],
      ['pause', onPause],
      ['seeking', onSeeking],
      ['seeked', onSeeked],
      ['waiting', onWaiting],
      ['ended', onEndedEvent],
    ];
    for (const [type, listener] of listeners) video.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) video.removeEventListener(type, listener);
    };
  }, [tracker]);

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
      ...(startPosition === undefined ? {} : { startPosition }),
    });
    controllerRef.current = controller;
    void controller.start();
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The start position applies to the first load of a source only; changing it later (the
    // parent saw new progress) must not reload the video.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
