import {
  type ClientCompletionCause,
  isCompletionCauseAllowed,
  type LectureCompletionCause,
  type LectureType,
  progressPct,
} from '@udemy/contracts';
import { CompletionNotAllowed } from './learning.errors';

/**
 * Lecture completion rules (design D4, D5; decisions P5-D2/P5-D3).
 *
 * - VIDEO completes only by the server-measured coverage (`VIDEO_WATCHED`);
 * - ARTICLE by `ARTICLE_READ` or a manual tick, RESOURCE by `RESOURCE_OPENED` or a manual tick;
 * - QUIZ only by a passed attempt (`QUIZ_PASSED`, P5-T11).
 * Un-completing is allowed for every type and never touches the course completion.
 */

/** A client cause (`POST …/completion`) must match the lecture type, else 422. */
export function assertClientCompletionAllowed(
  type: LectureType,
  cause: ClientCompletionCause,
): void {
  if (!isCompletionCauseAllowed(type, cause)) throw new CompletionNotAllowed();
}

/** A server-side cause (heartbeat, quiz pass) must match the type: a mismatch is a bug. */
export function assertServerCompletionAllowed(
  type: LectureType,
  cause: LectureCompletionCause,
): void {
  if (!isCompletionCauseAllowed(type, cause)) {
    throw new RangeError(`cause ${cause} is not allowed for a ${type} lecture`);
  }
}

export interface CourseProgressFigures {
  readonly completed: number;
  readonly total: number;
  /** ⌊completed / total × 100⌋ (D5), 0 for an empty curriculum. */
  readonly pct: number;
}

/** Completed ∩ live lecture ids over the live lecture count (D5). */
export function courseProgressOf(
  completedLectureIds: ReadonlySet<string>,
  liveLectureIds: readonly string[],
): CourseProgressFigures {
  const live = new Set(liveLectureIds);
  let completed = 0;
  for (const id of live) if (completedLectureIds.has(id)) completed++;
  return { completed, total: live.size, pct: progressPct(completed, live.size) };
}
