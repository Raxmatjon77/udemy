import { Injectable } from '@nestjs/common';
import { AnswerDeleted, QuestionReopened } from '@udemy/contracts';
import { AnswerNotFound, NotContentAuthor } from '../../domain/engagement.errors';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { TransactionRunner } from '../ports/transaction-runner';
import { QaAccess, type QaViewer } from '../qa-access';
import { answerInCourse } from '../qa-lookups';

export interface DeleteAnswerInput {
  readonly viewer: QaViewer;
  readonly courseId: string;
  readonly answerId: string;
}

/**
 * `DeleteAnswer` (design §5): the author only; a soft delete. The DB trigger recounts the
 * question and clears its accepted answer if it was this one; the answer and then the question
 * are locked first (the trigger's order) to know that, so `AnswerDeleted` is followed by
 * `QuestionReopened` exactly when the question was resolved by this answer.
 *
 * Errors: 403 `enrollment_required` / `not_content_author`, 404 `answer_not_found`.
 */
@Injectable()
export class DeleteAnswerCommand {
  constructor(
    private readonly access: QaAccess,
    private readonly qa: QaRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
    private readonly hints: QaHints,
  ) {}

  async execute(input: DeleteAnswerInput): Promise<void> {
    const course = await this.access.require(input.courseId, input.viewer);
    const viewerId = input.viewer.userId;

    const question = await this.tx.run(async (trx) => {
      const found = answerInCourse(
        await this.qa.findAnswer(input.answerId, trx),
        course.courseId,
        viewerId,
      );
      if (found.answer.authorId !== viewerId) throw new NotContentAuthor();
      const lock = await this.qa.lockAnswerAcceptance(trx, found.answer.id);
      const deleted = await this.qa.softDeleteAnswer(trx, found.answer.id);
      if (lock === null || deleted === null || deleted.deletedAt === null) {
        throw new AnswerNotFound();
      }
      const at = deleted.deletedAt.toISOString();
      const ids = {
        questionId: found.question.id,
        courseId: found.question.courseId,
        actorId: viewerId,
      };
      await this.events.publish(trx, AnswerDeleted, {
        ...ids,
        answerId: deleted.id,
        deletedAt: at,
      });
      if (lock.wasAccepted) {
        await this.events.publish(trx, QuestionReopened, {
          ...ids,
          answerId: deleted.id,
          reopenedAt: at,
        });
      }
      return found.question;
    });
    await this.hints.changed({
      courseId: question.courseId,
      questionId: question.id,
      lectureId: question.lectureId,
    });
  }
}
