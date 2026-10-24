import { Injectable } from '@nestjs/common';
import type { InstructorQaItem, InstructorQaPage, InstructorQaStatus } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { CourseNotFound } from '../../domain/engagement.errors';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { QaRepository } from '../ports/qa.repository';
import { QaPresenter } from '../qa-presenter';

export interface InstructorQaInboxInput {
  /** The caller (`course:engage:own`): only their own courses are searched. */
  readonly ownerId: string;
  readonly courseId?: string | undefined;
  readonly status: InstructorQaStatus;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `InstructorQaInbox` (design §5): VISIBLE, non-deleted questions over the caller's live
 * courses (ids from `CatalogFacade`, at most 100, the most recently published first) or one of
 * them (`courseId`; a course the caller does not own is 404, IDOR), newest first, keyset
 * (created_at, id). `unanswered` = no visible answer, `unresolved` = no accepted answer.
 * Each item carries the course card and the title of the question's lecture in the live
 * revision (null for general questions, or a lecture a later revision removed).
 *
 * Errors: 400 (query), 404 `course_not_found`, 422 invalid cursor.
 */
@Injectable()
export class InstructorQaInboxQuery {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly qa: QaRepository,
    private readonly presenter: QaPresenter,
  ) {}

  async execute(input: InstructorQaInboxInput): Promise<InstructorQaPage> {
    const after = decodeOptionalKeyset(input.cursor);
    const courseIds = await this.ownedCourseIds(input);
    if (courseIds.length === 0) return { items: [], nextCursor: null };
    const rows = await this.qa.listInbox({
      courseIds,
      status: input.status,
      after: after === null ? null : { createdAt: after.at, id: after.id },
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit).map((r) => r.record);
    const pageCourseIds = [...new Set(page.map((q) => q.courseId))];
    const [courses, lectureTitles, questions] = await Promise.all([
      this.catalog.getCourseSummaries(pageCourseIds),
      this.lectureTitles(page.filter((q) => q.lectureId !== null).map((q) => q.courseId)),
      this.presenter.questions(page, input.ownerId, () => input.ownerId),
    ]);
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const questionById = new Map(questions.map((q) => [q.id, q]));
    return toPage(
      rows,
      input.limit,
      (row) => ({ at: row.createdAtKey, id: row.record.id }),
      (shown) =>
        shown.flatMap(({ record }): InstructorQaItem[] => {
          const course = courseById.get(record.courseId);
          const question = questionById.get(record.id);
          // a course deleted since the id lookup: nothing to link to
          if (course === undefined || question === undefined) return [];
          return [
            {
              question,
              course: { id: course.id, slug: course.slug, title: course.title },
              lectureTitle:
                record.lectureId === null
                  ? null
                  : (lectureTitles.get(`${record.courseId}:${record.lectureId}`) ?? null),
            },
          ];
        }),
    );
  }

  private async ownedCourseIds(input: InstructorQaInboxInput): Promise<string[]> {
    if (input.courseId === undefined) return this.catalog.getOwnedLiveCourseIds(input.ownerId);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null || course.ownerId !== input.ownerId) throw new CourseNotFound();
    return [course.id];
  }

  /** `courseId:lectureId` -> live title (one cached curriculum read per course). */
  private async lectureTitles(courseIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const titles = new Map<string, string>();
    const curricula = await Promise.all(
      [...new Set(courseIds)].map((id) => this.catalog.getLiveCurriculum(id)),
    );
    for (const curriculum of curricula) {
      if (curriculum === null) continue;
      for (const section of curriculum.sections) {
        for (const lecture of section.lectures) {
          titles.set(`${curriculum.courseId}:${lecture.id}`, lecture.title);
        }
      }
    }
    return titles;
  }
}
