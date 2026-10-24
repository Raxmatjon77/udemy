import type { CompletionState, LectureCompletionCause } from '@udemy/contracts';
import type { LiveCurriculum } from '../../../catalog';
import { courseProgressOf } from '../../domain/completion-policy';
import { liveLecturesOf } from '../learner-access';
import type { LearningRepository } from '../ports/learning.repository';

/**
 * `CompletionState` of one lecture after a toggle, read in the same transaction as the write
 * (so it reflects exactly what was committed).
 */
export async function readCompletionState(
  completions: LearningRepository,
  ex: Parameters<LearningRepository['listCompletions']>[2],
  userId: string,
  curriculum: LiveCurriculum,
  lectureId: string,
): Promise<CompletionState> {
  // Sequential: inside a transaction both statements share one connection.
  const rows = await completions.listCompletions(userId, curriculum.courseId, ex);
  const courseCompletion = await completions.findCourseCompletion(userId, curriculum.courseId, ex);
  const mine = rows.find((r) => r.lectureId === lectureId);
  const progress = courseProgressOf(
    new Set(rows.map((r) => r.lectureId)),
    liveLecturesOf(curriculum).map((l) => l.id),
  );
  const cause: LectureCompletionCause | null = mine?.cause ?? null;
  return {
    lectureId,
    completed: mine !== undefined,
    cause,
    completedAt: mine?.completedAt.toISOString() ?? null,
    progress,
    courseCompletedAt: courseCompletion?.completedAt.toISOString() ?? null,
  };
}
