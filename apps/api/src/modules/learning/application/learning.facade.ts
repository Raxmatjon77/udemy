import { Injectable } from '@nestjs/common';
import type { CertificateStatus } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { CatalogFacade } from '../../catalog';
import { courseProgressOf } from '../domain/completion-policy';
import { isUuid, liveLecturesOf } from './learner-access';
import { LearningRepository } from './ports/learning.repository';

/** `LearningFacade.getConsumption` (design §3, D8): what a learner consumed of a course. */
export interface LearningConsumption {
  /** Covered buckets × 5 s, clamped per lecture, on the LIVE assets only (D3). */
  readonly videoSecondsWatched: number;
  /** Sum of the live VIDEO durations. */
  readonly videoSecondsTotal: number;
  /** Completed ∩ live lecture ids. */
  readonly completedLectures: number;
  readonly totalLectures: number;
  readonly courseCompletedAt: Date | null;
  readonly certificateStatus: CertificateStatus | null;
}

/**
 * Public facade of the learning context (design §3). Reads take an optional executor so
 * callers can read inside their own transaction (commerce's refund transaction, D8).
 *
 * - `getConsumption`: commerce's `LearningConsumptionPolicy` (P5-T16). Reads only, no locks;
 *   at most one flush (≤ 15 s) behind the Redis buffer, fine for a NEEDS_REVIEW signal.
 * - `completedLectureCount`: engagement's review gate (D10), through the global
 *   `LECTURE_COMPLETIONS` port that AppModule binds to this facade.
 *
 * Unknown or unpublished courses and malformed ids read as "nothing consumed".
 */
@Injectable()
export class LearningFacade {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly completions: LearningRepository,
  ) {}

  async getConsumption(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<LearningConsumption> {
    if (!isUuid(userId) || !isUuid(courseId)) return NOTHING_CONSUMED;
    const curriculum = await this.catalog.getLiveCurriculum(courseId, ex);
    const lectures =
      curriculum === null
        ? []
        : liveLecturesOf(curriculum).map((l) => ({
            lectureId: l.id,
            type: l.type,
            mediaAssetId: l.mediaAssetId,
            durationSeconds: l.durationSeconds,
          }));
    return this.completions.consumption(userId, courseId, lectures, ex);
  }

  /** Completed lectures ∩ the live revision's lecture ids; 0 when none (or unknown). */
  async completedLectureCount(userId: string, courseId: string, ex?: Executor): Promise<number> {
    if (!isUuid(userId) || !isUuid(courseId)) return 0;
    const curriculum = await this.catalog.getLiveCurriculum(courseId, ex);
    if (curriculum === null) return 0;
    const completed = await this.completions.listCompletedLectureIds(userId, courseId, ex);
    return courseProgressOf(
      new Set(completed),
      liveLecturesOf(curriculum).map((l) => l.id),
    ).completed;
  }
}

const NOTHING_CONSUMED: LearningConsumption = Object.freeze({
  videoSecondsWatched: 0,
  videoSecondsTotal: 0,
  completedLectures: 0,
  totalLectures: 0,
  courseCompletedAt: null,
  certificateStatus: null,
});
