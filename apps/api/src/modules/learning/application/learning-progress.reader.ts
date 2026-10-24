import { Injectable } from '@nestjs/common';
import { progressPct } from '@udemy/contracts';
import type { CourseProgressReader } from '../../../shared/learning-progress';
import { CatalogFacade, LIVE_CURRICULUM_INDEX_MAX_IDS } from '../../catalog';
import { isUuid } from './learner-access';
import { LearningRepository } from './ports/learning.repository';

/**
 * The `COURSE_PROGRESS` adapter (design D21): "how far is this user through these courses?"
 * for the my-learning cards. AppModule binds it with
 * `CourseProgressModule.forRoot({ imports: [LearningModule], useExisting: LearningProgressReader })`.
 *
 * Depends ONLY on its repository and `CatalogFacade`, never on `EnrollmentFacade`: enrollment
 * injects the global token, so a dependency back on enrollment would be a cycle (boot test).
 *
 * Per chunk of ≤ 48 courses: one `getLiveCurriculumIndex` call and one GROUP BY. pct =
 * ⌊completed ∩ live / live × 100⌋ (D5). Courses without a live revision are absent (the card
 * shows null); every other course has a value, 0 included.
 */
@Injectable()
export class LearningProgressReader implements CourseProgressReader {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly completions: LearningRepository,
  ) {}

  async getPercents(
    userId: string,
    courseIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const result = new Map<string, number>();
    if (!isUuid(userId)) return result;
    const ids = [...new Set(courseIds)].filter(isUuid);
    for (let i = 0; i < ids.length; i += LIVE_CURRICULUM_INDEX_MAX_IDS) {
      const chunk = ids.slice(i, i + LIVE_CURRICULUM_INDEX_MAX_IDS);
      const index = await this.catalog.getLiveCurriculumIndex(chunk);
      if (index.size === 0) continue;
      const counts = await this.completions.progressCounts(
        userId,
        [...index].map(([courseId, entry]) => ({ courseId, lectureIds: entry.lectureIds })),
      );
      for (const courseId of chunk) {
        if (!index.has(courseId)) continue;
        const count = counts.get(courseId) ?? { completed: 0, total: 0 };
        result.set(courseId, progressPct(count.completed, count.total));
      }
    }
    return result;
  }
}
