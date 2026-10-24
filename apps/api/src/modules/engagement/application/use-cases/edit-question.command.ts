import { Injectable } from '@nestjs/common';
import type { Question } from '@udemy/contracts';
import { NotContentAuthor, QuestionNotFound } from '../../domain/engagement.errors';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { questionInCourse } from '../qa-lookups';
import { QaPresenter } from '../qa-presenter';

export interface EditQuestionInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
  readonly title?: string | undefined;
  readonly bodyMd?: string | undefined;
}

/**
 * `EditQuestion` (design §5): the author only, while the question is not deleted (a hidden
 * question stays editable by its author). `edited_at` moves only when something changed; no
 * event (payloads carry no text), a `qa.changed` hint after the commit.
 *
 * Errors: 403 `enrollment_required` / `not_content_author`, 404, 422 `markdown_not_allowed`.
 */
@Injectable()
export class EditQuestionCommand {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly tx: TransactionRunner,
    private readonly presenter: QaPresenter,
    private readonly hints: QaHints,
  ) {}

  async execute(input: EditQuestionInput): Promise<Question> {
    const course = await this.access.require(input.courseId, input.viewer);
    if (input.bodyMd !== undefined) assertMarkdownAllowed('bodyMd', input.bodyMd);
    const viewerId = input.viewer.userId;

    const question = await this.tx.run(async (trx) => {
      const current = questionInCourse(
        await this.qa.lockQuestion(trx, input.questionId),
        course.courseId,
        viewerId,
      );
      if (current.deletedAt !== null) throw new QuestionNotFound();
      if (current.authorId !== viewerId) throw new NotContentAuthor();
      const updated = await this.qa.updateQuestion(trx, current.id, {
        title: input.title,
        bodyMd: input.bodyMd,
      });
      if (updated === null) throw new QuestionNotFound();
      return updated;
    });
    await this.hints.changed({
      courseId: question.courseId,
      questionId: question.id,
      lectureId: question.lectureId,
    });
    return this.presenter.question(question, { viewerId, ownerId: course.ownerId });
  }
}
