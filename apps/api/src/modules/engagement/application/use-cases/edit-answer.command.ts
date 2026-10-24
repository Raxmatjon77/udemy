import { Injectable } from '@nestjs/common';
import type { Answer } from '@udemy/contracts';
import { AnswerNotFound, NotContentAuthor } from '../../domain/engagement.errors';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { answerInCourse } from '../qa-lookups';
import { QaPresenter } from '../qa-presenter';

export interface EditAnswerInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly answerId: string;
  readonly bodyMd: string;
}

/**
 * `EditAnswer` (design §5): the author only, while the answer is not deleted. The answer is
 * resolved within the course (composite: answer -> question -> course). No event; a
 * `qa.changed` hint after the commit.
 *
 * Errors: 403 `enrollment_required` / `not_content_author`, 404 `answer_not_found`,
 * 422 `markdown_not_allowed`.
 */
@Injectable()
export class EditAnswerCommand {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly tx: TransactionRunner,
    private readonly presenter: QaPresenter,
    private readonly hints: QaHints,
  ) {}

  async execute(input: EditAnswerInput): Promise<Answer> {
    const course = await this.access.require(input.courseId, input.viewer);
    assertMarkdownAllowed('bodyMd', input.bodyMd);
    const viewerId = input.viewer.userId;

    const { question, answer } = await this.tx.run(async (trx) => {
      const found = answerInCourse(
        await this.qa.findAnswer(input.answerId, trx),
        course.courseId,
        viewerId,
      );
      if (found.answer.authorId !== viewerId) throw new NotContentAuthor();
      const updated = await this.qa.updateAnswer(trx, found.answer.id, input.bodyMd);
      if (updated === null) throw new AnswerNotFound();
      return { question: found.question, answer: updated };
    });
    await this.hints.changed({
      courseId: question.courseId,
      questionId: question.id,
      lectureId: question.lectureId,
    });
    return this.presenter.answer(answer, question, { viewerId, ownerId: course.ownerId });
  }
}
