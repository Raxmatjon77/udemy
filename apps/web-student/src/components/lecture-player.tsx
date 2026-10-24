'use client';

import { useEffect, useRef, useState, type Ref } from 'react';
import { Button } from '@udemy/ui/components/button';
import {
  HlsPlayer,
  type HlsPlayerError,
  type HlsPlayerHandle,
  type PlayedRangesReport,
} from '@udemy/ui/components/hls-player';
import { cn } from '@udemy/ui/lib/utils';

import {
  DIAGNOSED_PLAYLIST_STATUSES,
  describePlaybackProblem,
  diagnosePlaylist,
  type PlaybackProblemView,
} from '@/lib/playback-problem';

interface ShownProblem {
  /** The player instance (`src#attempt`) the problem belongs to. */
  key: string;
  view: PlaybackProblemView;
  /** A 429: the retry stays disabled until `Retry-After` has passed. */
  waiting: boolean;
}

/**
 * `<HlsPlayer>` plus clear states for a refused master playlist (403/404/409/422/429, see
 * lib/playback-problem.ts). The player's own error overlay is hidden while ours is shown; a
 * retry remounts the player (a fresh master load) at the last known position. After a 429 the
 * retry waits `Retry-After`.
 *
 * The player carries the problem `code` and `Retry-After` of the refused master itself (it
 * reads them from the failed request); only when it could not (native HLS) the app GETs the
 * master once more through the BFF (`diagnosePlaylist`).
 *
 * Learning (Phase 5): `startPosition`, `onPlayedRanges`, `onPlayingChange`, `onEnded` and the
 * imperative `ref` (seek, flush) are passed through to the player.
 */
export function LecturePlayer({
  src,
  title,
  poster,
  className,
  startPosition,
  onPlayedRanges,
  onPlayingChange,
  onEnded,
  ref,
}: {
  src: string;
  title: string;
  poster?: string | undefined;
  className?: string;
  startPosition?: number | undefined;
  onPlayedRanges?: ((report: PlayedRangesReport) => void) | undefined;
  onPlayingChange?: ((playing: boolean) => void) | undefined;
  onEnded?: (() => void) | undefined;
  ref?: Ref<HlsPlayerHandle> | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState<ShownProblem | null>(null);
  /** Where a retry (remount) resumes: the last position the player reported. */
  const lastPosition = useRef<number | undefined>(startPosition);
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined);
  const key = `${src}#${attempt}`;
  const problem = shown?.key === key ? shown : null;

  const waitMs =
    problem?.waiting && problem.view.retryAfterSeconds ? problem.view.retryAfterSeconds * 1000 : 0;
  useEffect(() => {
    if (waitMs === 0) return;
    const timer = setTimeout(
      () => setShown((prev) => (prev?.key === key ? { ...prev, waiting: false } : prev)),
      waitMs,
    );
    return () => clearTimeout(timer);
  }, [waitMs, key]);

  async function onError(error: HlsPlayerError) {
    const status = error.httpStatus;
    if (status === undefined || !DIAGNOSED_PLAYLIST_STATUSES.has(status)) {
      return; // 401, network and media errors: the player's own state is right
    }
    const known = {
      status,
      code: error.code ?? null,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
    };
    const waiting = (view: PlaybackProblemView) =>
      view.retryAfterSeconds !== null && view.retryAfterSeconds > 0;
    if (error.code !== undefined) {
      const view = describePlaybackProblem(known);
      setShown({ key, view, waiting: waiting(view) });
      return;
    }
    // Shown at once from the status, then refined with the problem body.
    setShown({ key, view: describePlaybackProblem(known), waiting: false });
    const view = describePlaybackProblem(await diagnosePlaylist(src, status));
    setShown((prev) => (prev?.key === key ? { key, view, waiting: waiting(view) } : prev));
  }

  return (
    <div className={cn('relative', className)} data-slot="lecture-player">
      <HlsPlayer
        key={key}
        ref={ref}
        src={src}
        poster={poster}
        title={title}
        startPosition={attempt === 0 ? startPosition : retryAt}
        onPlayedRanges={(report) => {
          lastPosition.current = report.positionSeconds;
          onPlayedRanges?.(report);
        }}
        onPlayingChange={onPlayingChange}
        onEnded={onEnded}
        onError={(error) => void onError(error)}
        className={problem ? '[&>[role=alert]]:hidden' : undefined}
      />
      {problem ? (
        <div
          role="alert"
          data-testid="playback-problem"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-black/85 p-6 text-center text-sm text-white"
        >
          <p className="max-w-sm">{problem.view.message}</p>
          {problem.view.retryable ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={problem.waiting}
              onClick={() => {
                setRetryAt(lastPosition.current);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
