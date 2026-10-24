import { Injectable } from '@nestjs/common';
import type { AnswerPage } from '@udemy/contracts';
import type { QuestionRecord } from '../../domain/qa';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { QaRepository } from '../ports/qa.repository';
import { QaAccess, type QaViewer } from '../qa-access';
import { findVisibleQuestion } from '../qa-lookups';
import { QaPresenter, type QaViewContext } from '../qa-presenter';

export interface ListAnswersInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `GET /courses/:courseId/questions/:questionId/answers` (design §8 Q&A): the answers the viewer
 * can see (not deleted; hidden ones only to their author), oldest first, keyset
 * (created_at, id). Also the first page of `GetQuestion`.
 *
 * Errors: 403, 404 `course_not_found` / `question_not_found`, 422 invalid cursor.
 */
@Injectable()
export class ListAnswersQuery {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly presenter: QaPresenter,
  ) {}

  async execute(input: ListAnswersInput): Promise<AnswerPage> {
    const course = await this.access.require(input.courseId, input.viewer);
    const question = await findVisibleQuestion(
      this.qa,
      course.courseId,
      input.questionId,
      input.viewer.userId,
    );
    return this.page(question, { viewerId: input.viewer.userId, ownerId: course.ownerId }, input);
  }

  /** One answers page of a question the viewer may see. */
  async page(
    question: QuestionRecord,
    ctx: QaViewContext,
    paging: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<AnswerPage> {
    const after = decodeOptionalKeyset(paging.cursor);
    const rows = await this.qa.listAnswers(
      question.id,
      ctx.viewerId,
      after === null ? null : { createdAt: after.at, id: after.id },
      paging.limit + 1,
    );
    const pageRows = rows.slice(0, paging.limit);
    const answers = await this.presenter.answers(
      pageRows.map((r) => r.record),
      question,
      ctx,
    );
    const byId = new Map(answers.map((a) => [a.id, a]));
    return toPage(
      rows,
      paging.limit,
      (row) => ({ at: row.createdAtKey, id: row.record.id }),
      (shown) => shown.flatMap((row) => byId.get(row.record.id) ?? []),
    );
  }
}
