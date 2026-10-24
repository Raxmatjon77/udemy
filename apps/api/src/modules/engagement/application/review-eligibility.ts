import { Inject, Injectable } from '@nestjs/common';
import type { ReviewBlockReason } from '@udemy/contracts';
import {
  LECTURE_COMPLETIONS,
  type LectureCompletionCounter,
} from '../../../shared/learning-progress';
import { EnrollmentFacade } from '../../enrollment';
import { reviewBlockReason } from '../domain/review';

/**
 * The review gate (D10, P5-D8): not the owner, an ACTIVE enrollment, and at least one completed
 * lecture of the live revision. Completions come from learning through the global
 * `LECTURE_COMPLETIONS` port (P5-T10 binds `LearningFacade`; until then nobody is eligible).
 * Later checks are skipped once one fails (no completion read for a non-enrolled user).
 */
@Injectable()
export class ReviewEligibility {
  constructor(
    private readonly enrollment: EnrollmentFacade,
    @Inject(LECTURE_COMPLETIONS) private readonly completions: LectureCompletionCounter,
  ) {}

  async blockReason(
    userId: string,
    course: { readonly id: string; readonly ownerId: string },
  ): Promise<ReviewBlockReason | null> {
    const isOwner = course.ownerId === userId;
    if (isOwner)
      return reviewBlockReason({ isOwner, hasActiveEnrollment: false, completedLectures: 0 });
    const hasActiveEnrollment = await this.enrollment.hasAccess(userId, course.id);
    if (!hasActiveEnrollment) {
      return reviewBlockReason({ isOwner, hasActiveEnrollment, completedLectures: 0 });
    }
    const completedLectures = await this.completions.completedLectureCount(userId, course.id);
    return reviewBlockReason({ isOwner, hasActiveEnrollment, completedLectures });
  }
}
