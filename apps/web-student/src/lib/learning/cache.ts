import type { QueryClient } from '@tanstack/react-query';
import {
  type CompletionState,
  type PlayerBootstrap,
  type PlayerLecture,
  type ProgressAck,
} from '@udemy/contracts';

import { learningKeys } from './client';

/**
 * Keeps the player bootstrap (curriculum ticks, % bar) in step with what the server answered
 * to a heartbeat, a completion toggle or a quiz submit, without refetching the whole bootstrap.
 * A new course completion refetches it (completedAt, then the certificate).
 */

export function allLectures(bootstrap: PlayerBootstrap): PlayerLecture[] {
  return bootstrap.sections.flatMap((section) => section.lectures);
}

function updateLecture(
  bootstrap: PlayerBootstrap,
  lectureId: string,
  patch: Partial<PlayerLecture>,
): PlayerBootstrap {
  return {
    ...bootstrap,
    sections: bootstrap.sections.map((section) => ({
      ...section,
      lectures: section.lectures.map((lecture) =>
        lecture.id === lectureId ? { ...lecture, ...patch } : lecture,
      ),
    })),
  };
}

/** After `POST`/`DELETE …/completion`. */
export function applyCompletionState(
  queryClient: QueryClient,
  courseId: string,
  state: CompletionState,
): void {
  const key = learningKeys.bootstrap(courseId);
  const before = queryClient.getQueryData<PlayerBootstrap>(key);
  if (!before) return;
  const next = updateLecture(before, state.lectureId, {
    completed: state.completed,
    completedAt: state.completedAt,
  });
  queryClient.setQueryData<PlayerBootstrap>(key, {
    ...next,
    progress: state.progress,
    completedAt: state.courseCompletedAt,
  });
  if (before.completedAt === null && state.courseCompletedAt !== null) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** After a heartbeat or a quiz submit: the lecture and course state the server reports. */
export function applyProgressAck(
  queryClient: QueryClient,
  courseId: string,
  lectureId: string,
  ack: ProgressAck,
): void {
  const key = learningKeys.bootstrap(courseId);
  const before = queryClient.getQueryData<PlayerBootstrap>(key);
  if (!before) return;
  const lecture = allLectures(before).find((l) => l.id === lectureId);
  const newlyCompleted = ack.lectureCompleted && lecture !== undefined && !lecture.completed;
  let next: PlayerBootstrap = newlyCompleted
    ? updateLecture(before, lectureId, { completed: true, completedAt: new Date().toISOString() })
    : before;
  const completed = allLectures(next).filter((l) => l.completed).length;
  const total = before.progress.total;
  // The % is the server's (D5); the count follows the ticks.
  next = {
    ...next,
    progress: { completed: Math.min(completed, total), total, pct: ack.coursePct },
  };
  queryClient.setQueryData<PlayerBootstrap>(key, next);
  if (newlyCompleted || (ack.courseCompleted && before.completedAt === null)) {
    // The authoritative completedAt (and the course completion) come with a refetch.
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
