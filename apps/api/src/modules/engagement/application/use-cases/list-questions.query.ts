import { Injectable } from '@nestjs/common';
import type { QaSort, QuestionPage } from '@udemy/contracts';
import { QaRepository } from '../ports/qa.repository';
import { QaAccess, type QaViewer } from '../qa-access';
import { decodeQuestionCursor, encodeQuestionCursor } from '../qa-cursor';
import { QaPresenter } from '../qa-presenter';

export interface ListQuestionsInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly lectureId?: string | undefined;
  readonly sort: QaSort;
  /** Title search, already trimmed and >= 3 characters (contracts `QuestionsQuerySchema`). */
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `ListQuestions` (design §5, D12): learner or owner; VISIBLE, non-deleted questions of the
 * course, optionally one lecture's (`lectureId`, any lecture id: questions about a lecture a
 * later revision removed stay findable) and a title search. Keyset per sort through
 * `@udemy/db` `listQuestions`: `recent` (last activity), `top` (upvotes; not stable under
 * concurrent votes, clients de-duplicate by id, P5-D12), `unanswered` (newest first).
 *
 * Errors: 403 `enrollment_required`, 404 `course_not_found`, 422 invalid cursor.
 */
@Injectable()
export class ListQuestionsQuery {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly presenter: QaPresenter,
  ) {}

  async execute(input: ListQuestionsInput): Promise<QuestionPage> {
    const course = await this.access.require(input.courseId, input.viewer);
    const after = decodeQuestionCursor(input.cursor, input.sort);
    const rows = await this.qa.listQuestions({
      courseId: course.courseId,
      sort: input.sort,
      lectureId: input.lectureId,
      titleContains: input.q,
      after,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const items = await this.presenter.questions(
      page.map((r) => r.question),
      input.viewer.userId,
      () => course.ownerId,
    );
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > input.limit && last !== undefined ? encodeQuestionCursor(last.cursor) : null,
    };
  }
}
