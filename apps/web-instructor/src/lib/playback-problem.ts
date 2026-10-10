import { ErrorCode } from '@udemy/contracts';
import { ProxyFetchError } from '@udemy/web-auth/client';

import { formatWait } from './problem';

/**
 * Clear UI states for a refused HLS master playlist (design D7, P2-T11):
 * 403 `lecture_locked` / `forbidden`, 404, 409 `media_not_ready`, 422 `lecture_type_mismatch`,
 * 429 `rate_limited` with `Retry-After`.
 *
 * `<HlsPlayer>` (@udemy/ui) only reports the HTTP status of a failed playlist, not the problem
 * body or headers, and treats 422/429 as a network error. So when the master fails with one of
 * these statuses the app GETs it once more through the BFF to read the stable `code` and
 * `Retry-After` (see `diagnosePlaylist`).
 */

/** Statuses whose problem the app explains itself (401 and network errors stay with the player). */
export const DIAGNOSED_PLAYLIST_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422, 429]);

export interface PlaybackProblem {
  status: number;
  code: string | null;
  retryAfterSeconds: number | null;
}

export interface PlaybackProblemView {
  message: string;
  /** A retry may help (processing, rate limit); otherwise no "Try again" button. */
  retryable: boolean;
  /** Seconds to wait before the retry (429 `Retry-After`), or null. */
  retryAfterSeconds: number | null;
}

/** GETs the master playlist once to read the problem behind a failed load. */
export async function diagnosePlaylist(src: string, status: number): Promise<PlaybackProblem> {
  try {
    const response = await fetch(src, {
      headers: { accept: 'application/problem+json, application/vnd.apple.mpegurl' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.ok) {
      await response.body?.cancel();
      // It works now (a race with processing or the rate window): offer a retry.
      return { status: 0, code: null, retryAfterSeconds: null };
    }
    const error = await ProxyFetchError.fromResponse(response);
    return {
      status: error.status,
      code: error.code ?? null,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  } catch {
    return { status, code: null, retryAfterSeconds: null };
  }
}

/** Working-copy preview (owner or admin). */
export function describePlaybackProblem(problem: PlaybackProblem): PlaybackProblemView {
  const final = (message: string): PlaybackProblemView => ({
    message,
    retryable: false,
    retryAfterSeconds: null,
  });
  const retry = (message: string, retryAfterSeconds: number | null = null) => ({
    message,
    retryable: true,
    retryAfterSeconds,
  });

  if (problem.code === ErrorCode.RateLimited || problem.status === 429) {
    const wait = problem.retryAfterSeconds;
    return retry(
      `Too many playback requests. ${
        wait === null ? 'Please wait a little and try again.' : `Try again ${formatWait(wait)}.`
      }`,
      wait,
    );
  }
  if (problem.code === ErrorCode.MediaNotReady || problem.status === 409) {
    return retry(
      'This video is still being processed (or no video is attached). Try again when it is ready.',
    );
  }
  if (problem.code === ErrorCode.LectureTypeMismatch || problem.status === 422) {
    return final('This lecture is not a video lecture, so there is nothing to play.');
  }
  if (problem.code === ErrorCode.LectureLocked || problem.status === 403) {
    return final('You do not have access to this video.');
  }
  if (problem.status === 404) {
    return final('This lecture or its video no longer exists. Reload the curriculum.');
  }
  return retry('The video could not be loaded. Try again.');
}
