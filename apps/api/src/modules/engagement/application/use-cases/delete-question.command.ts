import { Injectable } from '@nestjs/common';
import { QuestionDeleted } from '@udemy/contracts';
import { NotContentAuthor, QuestionNotFound } from '../../domain/engagement.errors';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { questionInCourse } from '../qa-lookups';

export interface DeleteQuestionInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly questionId: string;
}

/**
 * `DeleteQuestion` (design §5): the author only; a soft delete with `QuestionDeleted` (the
 * worker redacts its notifications). A question with visible answers keeps a "[deleted]"
 * placeholder; without answers it disappears. A second delete is 404.
 *
 * Errors: 403 `enrollment_required` / `not_content_author`, 404 `question_not_found`.
 */
@Injectable()
export class DeleteQuestionCommand {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly hints: QaHints,
  ) {}

  async execute(input: DeleteQuestionInput): Promise<void> {
    const course = await this.access.require(input.courseId, input.viewer);
    const viewerId = input.viewer.userId;
    const deleted = await this.tx.run(async (trx) => {
      const current = questionInCourse(
        await this.qa.lockQuestion(trx, input.questionId),
        course.courseId,
        viewerId,
      );
      if (current.deletedAt !== null) throw new QuestionNotFound();
      if (current.authorId !== viewerId) throw new NotContentAuthor();
      const after = await this.qa.softDeleteQuestion(trx, current.id);
      if (after === null || after.deletedAt === null) throw new QuestionNotFound();
      await this.events.publish(trx, QuestionDeleted, {
        questionId: after.id,
        courseId: after.courseId,
        actorId: viewerId,
        deletedAt: after.deletedAt.toISOString(),
      });
      return after;
    });
    await this.hints.changed({
      courseId: deleted.courseId,
      questionId: deleted.id,
      lectureId: deleted.lectureId,
    });
  }
}
