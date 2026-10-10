import { Injectable } from '@nestjs/common';
import type { AdminEnrollment } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { CatalogFacade, COURSE_SUMMARIES_MAX_IDS, type CourseSummary } from '../../catalog';
import type { Enrollment, EnrollmentTransition } from '../domain/enrollment';
import { EnrollmentRepository } from './ports/enrollment.repository';
import { toAdminEnrollmentView } from './views';

/**
 * Builds `AdminEnrollment` views (support: rows with source, course and the full transition
 * log): one transitions query plus `CatalogFacade.getCourseSummaries` in batches of at most
 * `COURSE_SUMMARIES_MAX_IDS`, whatever the number of rows.
 */
@Injectable()
export class AdminEnrollmentAssembler {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly catalog: CatalogFacade,
  ) {}

  async assemble(rows: readonly Enrollment[], ex?: Executor): Promise<AdminEnrollment[]> {
    if (rows.length === 0) return [];
    const transitions = await this.enrollments.listTransitions(
      rows.map((r) => r.id),
      ex,
    );
    const byEnrollment = new Map<string, EnrollmentTransition[]>();
    for (const t of transitions) {
      const list = byEnrollment.get(t.enrollmentId) ?? [];
      list.push(t);
      byEnrollment.set(t.enrollmentId, list);
    }
    const courses = await this.courseSummaries(
      rows.map((r) => r.courseId),
      ex,
    );
    return rows.map((row) =>
      toAdminEnrollmentView(row, byEnrollment.get(row.id) ?? [], courses.get(row.courseId)),
    );
  }

  async assembleOne(row: Enrollment, ex?: Executor): Promise<AdminEnrollment> {
    const [view] = await this.assemble([row], ex);
    if (view === undefined) throw new Error('assemble returned no view for one row');
    return view;
  }

  private async courseSummaries(
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, CourseSummary>> {
    const ids = [...new Set(courseIds)];
    const result = new Map<string, CourseSummary>();
    for (let i = 0; i < ids.length; i += COURSE_SUMMARIES_MAX_IDS) {
      const batch = await this.catalog.getCourseSummaries(
        ids.slice(i, i + COURSE_SUMMARIES_MAX_IDS),
        ex,
      );
      for (const summary of batch) result.set(summary.id, summary);
    }
    return result;
  }
}
