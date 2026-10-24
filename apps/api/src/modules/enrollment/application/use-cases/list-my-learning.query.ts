import { Inject, Injectable } from '@nestjs/common';
import type { LearningCard, LearningCardPage } from '@udemy/contracts';
import { COURSE_PROGRESS, type CourseProgressReader } from '../../../../shared/learning-progress';
import { CatalogFacade } from '../../../catalog';
import { UsersFacade } from '../../../users';
import { decodeMyLearningCursor, encodeMyLearningCursor } from '../enrollment-cursor';
import { EnrollmentRepository } from '../ports/enrollment.repository';

export interface ListMyLearningInput {
  readonly userId: string;
  readonly cursor?: string;
  /** 1–24 (the request schema enforces it). */
  readonly limit: number;
}

/**
 * `ListMyLearning` (design §5): the caller's ACTIVE enrollments, keyset `(granted_at DESC,
 * id DESC)`, as `LearningCard`s from `CatalogFacade.getCourseSummaries` (the live title and
 * thumbnail; `archived` badge, D13) and the instructor's public profile (null when banned).
 * `progress` comes from the global `COURSE_PROGRESS` port (Phase 5 D21; AppModule binds it to
 * learning's `LearningProgressReader`): one batched call per page, 0 when nothing is completed,
 * null when the reader has no value (no live revision, or `NoCourseProgress`). Enrollment never
 * imports learning (learning imports enrollment for its access checks).
 *
 * A course catalog no longer knows (deleted) is left out of the page; the cursor still moves
 * past it, so pages may be shorter than `limit`.
 *
 * Errors: 422 `validation_failed` for a cursor this api did not produce.
 */
@Injectable()
export class ListMyLearningQuery {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly catalog: CatalogFacade,
    private readonly users: UsersFacade,
    @Inject(COURSE_PROGRESS) private readonly progress: CourseProgressReader,
  ) {}

  async execute(input: ListMyLearningInput): Promise<LearningCardPage> {
    const after = input.cursor === undefined ? null : decodeMyLearningCursor(input.cursor);
    const rows = await this.enrollments.listActivePage(input.userId, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined ? encodeMyLearningCursor(last.keyset) : null;
    if (page.length === 0) return { items: [], nextCursor };

    const courses = new Map(
      (await this.catalog.getCourseSummaries(page.map((r) => r.enrollment.courseId))).map((c) => [
        c.id,
        c,
      ]),
    );
    const instructors = new Map(
      (
        await this.users.getPublicProfiles([
          ...new Set([...courses.values()].map((c) => c.ownerId)),
        ])
      ).map((p) => [p.id, p]),
    );
    const percents =
      courses.size === 0
        ? new Map<string, number>()
        : await this.progress.getPercents(input.userId, [...courses.keys()]);
    const items = page.flatMap(({ enrollment }): LearningCard[] => {
      const course = courses.get(enrollment.courseId);
      if (course === undefined) return [];
      const instructor = instructors.get(course.ownerId);
      return [
        {
          enrollmentId: enrollment.id,
          courseId: course.id,
          slug: course.slug,
          title: course.title,
          instructor:
            instructor === undefined
              ? null
              : { id: instructor.id, displayName: instructor.displayName },
          hasThumbnail: course.hasThumbnail,
          archived: course.status === 'ARCHIVED',
          source: enrollment.source,
          grantedAt: enrollment.grantedAt.toISOString(),
          progress: percents.get(course.id) ?? null,
        },
      ];
    });
    return { items, nextCursor };
  }
}
