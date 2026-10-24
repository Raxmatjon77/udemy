import { Injectable } from '@nestjs/common';
import type { QuestionDetail } from '@udemy/contracts';
import { QaRepository } from '../ports/qa.repository';
import { QaAccess, type QaViewer } from '../qa-access';
import { findVisibleQuestion } from '../qa-lookups';
import { QaPresenter } from '../qa-presenter';
import { ListAnswersQuery } from './list-answers.query';

export interface GetQuestionInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
  /** Paging of the embedded first answers page. */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `GET /courses/:courseId/questions/:questionId` (design §8 Q&A): the question with its first
 * answers page. A hidden question is visible to its author only (`hidden: true`, banner); a
 * deleted one with answers is a placeholder (`deleted: true`, no title, body or author).
 *
 * Errors: 403, 404 `course_not_found` / `question_not_found`.
 */
@Injectable()
export class GetQuestionQuery {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly presenter: QaPresenter,
    private readonly answers: ListAnswersQuery,
  ) {}

  async execute(input: GetQuestionInput): Promise<QuestionDetail> {
    const course = await this.access.require(input.courseId, input.viewer);
    const record = await findVisibleQuestion(
      this.qa,
      course.courseId,
      input.questionId,
      input.viewer.userId,
    );
    const ctx = { viewerId: input.viewer.userId, ownerId: course.ownerId };
    const [question, answers] = await Promise.all([
      this.presenter.question(record, ctx),
      this.answers.page(record, ctx, input),
    ]);
    return { ...question, answers };
  }
}
