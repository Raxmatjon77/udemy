import { Injectable } from '@nestjs/common';

/**
 * Injection token for the process-wide `LectureCompletionCounter` binding (Phase 5 learning
 * experience design §3 `LearningFacade.completedLectureCount`, D10). `Symbol.for` keeps the
 * token identical if this file is ever loaded twice.
 *
 *   constructor(@Inject(LECTURE_COMPLETIONS) private readonly completions: LectureCompletionCounter)
 */
export const LECTURE_COMPLETIONS = Symbol.for('udemy.LECTURE_COMPLETIONS');

/**
 * Port: "how many lectures of this course's LIVE revision has this user completed?" Engagement
 * asks it for the review gate (D10 / P5-D8: an ACTIVE enrollment and at least one completed
 * lecture).
 *
 * It lives in `shared`, like `COURSE_PROGRESS`, so engagement depends on an interface and only
 * AppModule knows the implementation. `LearningFacade` satisfies it structurally (its extra
 * optional executor parameter is allowed), so P5-T10 binds it with `useExisting`.
 */
export interface LectureCompletionCounter {
  /** Completed lectures ∩ the live revision's lecture ids; 0 when none (or unknown). */
  completedLectureCount(userId: string, courseId: string): Promise<number>;
}

/**
 * Default binding until learning binds `LearningFacade` (P5-T10). It knows no completions, so
 * the review gate fails CLOSED: every enrolled student gets `review_not_eligible` (422) instead
 * of being able to review without the progress requirement.
 */
@Injectable()
export class NoLectureCompletions implements LectureCompletionCounter {
  completedLectureCount(): Promise<number> {
    return Promise.resolve(0);
  }
}
