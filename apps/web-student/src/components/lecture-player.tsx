'use client';

import { useEffect, useState } from 'react';
import { Button } from '@udemy/ui/components/button';
import { HlsPlayer, type HlsPlayerError } from '@udemy/ui/components/hls-player';
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
 * retry remounts the player (a fresh master load). After a 429 the retry waits `Retry-After`.
 */
export function LecturePlayer({
  src,
  title,
  poster,
  className,
}: {
  src: string;
  title: string;
  poster?: string | undefined;
  className?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState<ShownProblem | null>(null);
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
    // Shown at once from the status, then refined with the problem body.
    setShown({
      key,
      view: describePlaybackProblem({ status, code: null, retryAfterSeconds: null }),
      waiting: false,
    });
    const view = describePlaybackProblem(await diagnosePlaylist(src, status));
    setShown((prev) =>
      prev?.key === key
        ? { key, view, waiting: view.retryAfterSeconds !== null && view.retryAfterSeconds > 0 }
        : prev,
    );
  }

  return (
    <div className={cn('relative', className)} data-slot="lecture-player">
      <HlsPlayer
        key={key}
        src={src}
        poster={poster}
        title={title}
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
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
